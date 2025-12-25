import * as vscode from 'vscode';
import { Connection } from './types';
import { DatabaseAdapterFactory, IDatabaseAdapter } from './database';

export class TableViewer {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private adapter: IDatabaseAdapter | undefined;
    private currentConnection: Connection | undefined;
    private currentDatabase: string | undefined;

    constructor(
        private context: vscode.ExtensionContext
    ) {}

    public async openTable(
        connection: Connection,
        database: string,
        tableName: string
    ) {
        // Reuse existing panel or create new one
        if (TableViewer.currentPanel) {
            TableViewer.currentPanel.title = tableName;
            TableViewer.currentPanel.reveal(vscode.ViewColumn.One);
        } else {
            TableViewer.currentPanel = vscode.window.createWebviewPanel(
                'tableViewer',
                tableName,
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    enableForms: true,
                    // Remove sandbox restrictions to allow modals
                    localResourceRoots: []
                }
            );

            TableViewer.currentPanel.onDidDispose(() => {
                TableViewer.currentPanel = undefined;
                if (this.adapter) {
                    this.adapter.close();
                }
            });
        }

        // Setup database connection
        try {
            if (this.adapter) {
                await this.adapter.close();
            }

            this.currentConnection = connection;
            this.currentDatabase = database;
            this.adapter = DatabaseAdapterFactory.createAdapter(connection);
            await this.adapter.testConnection();

            // Load and display data
            await this.loadTableData(tableName);

            // Handle messages from the webview
            TableViewer.currentPanel.webview.onDidReceiveMessage(
                async (message) => {
                    switch (message.command) {
                        case 'refresh':
                            await this.loadTableData(tableName);
                            break;
                        case 'delete':
                            // Ask for confirmation
                            const confirmDelete = await vscode.window.showWarningMessage(
                                'Are you sure you want to delete this row?',
                                'Yes',
                                'No'
                            );
                            if (confirmDelete === 'Yes') {
                                await this.deleteRow(tableName, message.row);
                            }
                            break;
                        case 'deleteMultiple':
                            // Handle multiple row deletion
                            if (message.rows && Array.isArray(message.rows)) {
                                // Ask for confirmation
                                const answer = await vscode.window.showWarningMessage(
                                    `Are you sure you want to delete ${message.rows.length} row(s)?`,
                                    'Yes',
                                    'No'
                                );
                                
                                if (answer !== 'Yes') {
                                    return;
                                }
                                
                                let successCount = 0;
                                let failCount = 0;
                                
                                for (const row of message.rows) {
                                    const success = await this.deleteRow(tableName, row, true);
                                    if (success) {
                                        successCount++;
                                    } else {
                                        failCount++;
                                    }
                                }
                                
                                await this.loadTableData(tableName);
                                
                                if (failCount === 0) {
                                    vscode.window.showInformationMessage(`${successCount} row(s) deleted successfully!`);
                                } else {
                                    vscode.window.showWarningMessage(`${successCount} row(s) deleted, ${failCount} failed.`);
                                }
                            }
                            break;
                        case 'update':
                            await this.updateRow(tableName, message.row, message.changes);
                            break;
                        case 'insert':
                            await this.insertRow(tableName, message.row);
                            break;
                        case 'query':
                            await this.loadTableData(tableName, message.search, message.limit, message.offset, message.sortColumn, message.sortDirection);
                            break;
                        case 'checkPendingChanges':
                            // Check if there are pending changes before refresh
                            if (message.hasPendingChanges) {
                                vscode.window.showInformationMessage(
                                    'You have pending edits. Please commit or revert changes before refreshing.',
                                    'Commit', 'Revert', 'Cancel'
                                ).then(async (choice) => {
                                    if (choice === 'Commit') {
                                        TableViewer.currentPanel?.webview.postMessage({ command: 'commitFromBackend' });
                                    } else if (choice === 'Revert') {
                                        TableViewer.currentPanel?.webview.postMessage({ command: 'revertFromBackend' });
                                    }
                                });
                            } else {
                                await this.loadTableData(tableName, message.search, message.limit, message.offset, message.sortColumn, message.sortDirection);
                            }
                            break;
                    }
                },
                undefined,
                this.context.subscriptions
            );

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to connect to database: ${errorMessage}`);
        }
    }

    private async loadTableData(
        tableName: string, 
        search?: string, 
        limit: number = 100, 
        offset: number = 0,
        sortColumn?: string,
        sortDirection?: string
    ) {
        if (!this.adapter || !this.currentDatabase || !this.currentConnection || !TableViewer.currentPanel) return;

        try {
            // Get table structure using adapter
            const columnsResult = await this.adapter.getColumns(this.currentDatabase, tableName);
            
            // Get primary keys
            const primaryKeys = await this.adapter.getPrimaryKeys(this.currentDatabase, tableName);
            
            // Get unique keys
            const uniqueKeys = await this.adapter.getUniqueKeys(this.currentDatabase, tableName);

            // Get identity/auto-increment columns (database-specific)
            let identityColumns: string[] = [];
            if (this.currentConnection.type === 'PostgreSQL') {
                const identityResult = await this.adapter.query(this.currentDatabase, `
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = $1 
                    AND table_schema = 'public'
                    AND (is_identity = 'YES' OR column_default LIKE 'nextval%')
                `, [tableName]);
                identityColumns = identityResult.rows.map((row: any) => row.column_name);
            } else {
                // MySQL/MariaDB
                const identityResult = await this.adapter.query(this.currentDatabase, `
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = ? 
                    AND table_schema = ?
                    AND extra LIKE '%auto_increment%'
                `, [tableName, this.currentDatabase]);
                identityColumns = identityResult.map((row: any) => row.column_name);
            }

            // Build query (database-specific)
            const isPostgres = this.currentConnection.type === 'PostgreSQL';
            const tableIdentifier = isPostgres ? tableName : `\`${tableName}\``;
            let query = `SELECT * FROM ${tableIdentifier}`;
            const params: any[] = [];
            let paramIndex = 1;

            if (search) {
                if (isPostgres) {
                    const searchConditions = columnsResult
                        .map((col: any) => `${col.column_name}::text ILIKE $${paramIndex}`)
                        .join(' OR ');
                    query += ` WHERE ${searchConditions}`;
                    params.push(`%${search}%`);
                    paramIndex++;
                } else {
                    // MySQL/MariaDB
                    const searchConditions = columnsResult
                        .map((col: any, idx: number) => `\`${col.column_name}\` LIKE ?`)
                        .join(' OR ');
                    query += ` WHERE ${searchConditions}`;
                    // Add search param for each column
                    columnsResult.forEach(() => params.push(`%${search}%`));
                }
            }

            // Get total count
            let countQuery: string;
            let countParams: any[] = [];
            
            if (search) {
                if (isPostgres) {
                    countQuery = `SELECT COUNT(*) FROM ${tableIdentifier} WHERE ${columnsResult
                        .map((col: any) => `${col.column_name}::text ILIKE $1`)
                        .join(' OR ')}`;
                    countParams = [`%${search}%`];
                } else {
                    countQuery = `SELECT COUNT(*) FROM ${tableIdentifier} WHERE ${columnsResult
                        .map((col: any) => `\`${col.column_name}\` LIKE ?`)
                        .join(' OR ')}`;
                    columnsResult.forEach(() => countParams.push(`%${search}%`));
                }
            } else {
                countQuery = `SELECT COUNT(*) FROM ${tableIdentifier}`;
            }
            
            const countResult = await this.adapter.query(this.currentDatabase, countQuery, countParams);
            const totalRows = isPostgres 
                ? parseInt(countResult.rows[0].count) 
                : parseInt(countResult[0]['COUNT(*)']);

            // Add ORDER BY clause if sort is specified
            if (sortColumn && sortDirection) {
                const columnIdentifier = isPostgres ? sortColumn : `\`${sortColumn}\``;
                query += ` ORDER BY ${columnIdentifier} ${sortDirection.toUpperCase()}`;
            }

            // Add LIMIT and OFFSET
            if (isPostgres) {
                query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
                params.push(limit, offset);
            } else {
                query += ` LIMIT ? OFFSET ?`;
                params.push(limit, offset);
            }

            const dataResult = await this.adapter.query(this.currentDatabase, query, params);
            const rows = isPostgres ? dataResult.rows : dataResult;

            TableViewer.currentPanel.webview.html = this.getWebviewContent(
                tableName,
                columnsResult,
                rows,
                primaryKeys,
                uniqueKeys,
                identityColumns,
                totalRows,
                limit,
                offset,
                search,
                sortColumn,
                sortDirection
            );

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to load table data: ${errorMessage}`);
        }
    }

    private async deleteRow(tableName: string, row: any, skipReload: boolean = false) {
        if (!this.adapter || !this.currentDatabase || !this.currentConnection) return false;

        try {
            // Get primary key columns
            const primaryKeys = await this.adapter.getPrimaryKeys(this.currentDatabase, tableName);

            if (primaryKeys.length === 0) {
                vscode.window.showErrorMessage('Cannot delete: table has no primary key');
                return false;
            }

            const isPostgres = this.currentConnection.type === 'PostgreSQL';
            const tableIdentifier = isPostgres ? tableName : `\`${tableName}\``;
            
            let whereConditions: string;
            let values: any[];
            
            if (isPostgres) {
                whereConditions = primaryKeys
                    .map((pk: string, idx: number) => `${pk} = $${idx + 1}`)
                    .join(' AND ');
                values = primaryKeys.map((pk: string) => row[pk]);
            } else {
                whereConditions = primaryKeys
                    .map((pk: string) => `\`${pk}\` = ?`)
                    .join(' AND ');
                values = primaryKeys.map((pk: string) => row[pk]);
            }

            await this.adapter.query(
                this.currentDatabase,
                `DELETE FROM ${tableIdentifier} WHERE ${whereConditions}`,
                values
            );

            if (!skipReload) {
                await this.loadTableData(tableName);
                vscode.window.showInformationMessage('Row deleted successfully!');
            }

            return true;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to delete row: ${errorMessage}`);
            return false;
        }
    }

    private async updateRow(tableName: string, originalRow: any, changes: any) {
        if (!this.adapter || !this.currentDatabase || !this.currentConnection) return;

        try {
            // Get primary key columns
            const primaryKeys = await this.adapter.getPrimaryKeys(this.currentDatabase, tableName);

            if (primaryKeys.length === 0) {
                vscode.window.showErrorMessage('Cannot update: table has no primary key');
                return;
            }

            const isPostgres = this.currentConnection.type === 'PostgreSQL';
            const tableIdentifier = isPostgres ? tableName : `\`${tableName}\``;
            
            let setClause: string;
            let whereConditions: string;
            let values: any[];
            
            if (isPostgres) {
                setClause = Object.keys(changes)
                    .map((key, idx) => `${key} = $${idx + 1}`)
                    .join(', ');

                whereConditions = primaryKeys
                    .map((pk: string, idx: number) => `${pk} = $${Object.keys(changes).length + idx + 1}`)
                    .join(' AND ');

                values = [
                    ...Object.values(changes),
                    ...primaryKeys.map((pk: string) => originalRow[pk])
                ];
            } else {
                setClause = Object.keys(changes)
                    .map((key) => `\`${key}\` = ?`)
                    .join(', ');

                whereConditions = primaryKeys
                    .map((pk: string) => `\`${pk}\` = ?`)
                    .join(' AND ');

                values = [
                    ...Object.values(changes),
                    ...primaryKeys.map((pk: string) => originalRow[pk])
                ];
            }

            await this.adapter.query(
                this.currentDatabase,
                `UPDATE ${tableIdentifier} SET ${setClause} WHERE ${whereConditions}`,
                values
            );

            await this.loadTableData(tableName);
            vscode.window.showInformationMessage('Row updated successfully!');

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to update row: ${errorMessage}`);
        }
    }

    private async insertRow(tableName: string, row: any) {
        if (!this.adapter || !this.currentDatabase || !this.currentConnection) return;

        try {
            const columns = Object.keys(row).filter(key => row[key] !== null && row[key] !== '');
            const values = columns.map(col => row[col]);

            const isPostgres = this.currentConnection.type === 'PostgreSQL';
            const tableIdentifier = isPostgres ? tableName : `\`${tableName}\``;
            
            let columnsClause: string;
            let placeholders: string;
            
            if (isPostgres) {
                columnsClause = columns.join(', ');
                placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');
            } else {
                columnsClause = columns.map(col => `\`${col}\``).join(', ');
                placeholders = columns.map(() => '?').join(', ');
            }

            await this.adapter.query(
                this.currentDatabase,
                `INSERT INTO ${tableIdentifier} (${columnsClause}) VALUES (${placeholders})`,
                values
            );

            await this.loadTableData(tableName);
            vscode.window.showInformationMessage('Row inserted successfully!');

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to insert row: ${errorMessage}`);
        }
    }

    private getWebviewContent(
        tableName: string,
        columns: any[],
        rows: any[],
        primaryKeys: string[],
        uniqueKeys: string[],
        identityColumns: string[],
        totalRows: number,
        limit: number,
        offset: number,
        search?: string,
        sortColumn?: string,
        sortDirection?: string
    ): string {
        const currentPage = Math.floor(offset / limit) + 1;
        const totalPages = Math.ceil(totalRows / limit);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${tableName}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            user-select: none;
        }
        
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
        }

        input, textarea {
            user-select: text;
        }

        input[type="checkbox"] {
            cursor: pointer;
            outline: none;
        }

        input[type="checkbox"]:focus {
            outline: none;
        }

        .toolbar {
            display: flex;
            gap: 12px;
            margin-bottom: 20px;
            align-items: center;
            padding: 10px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .search-container {
            position: relative;
            flex: 1;
            max-width: 400px;
        }

        .search-box {
            width: 100%;
            padding: 8px 32px 8px 12px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-size: 13px;
        }

        .search-box:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .search-clear {
            position: absolute;
            right: 8px;
            top: 50%;
            transform: translateY(-50%);
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 4px;
            display: none;
            opacity: 0.7;
            font-size: 16px;
            line-height: 1;
            width: 20px;
            height: 20px;
            border-radius: 2px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .search-clear:hover {
            opacity: 1;
            background-color: var(--vscode-focusBorder);
            color: var(--vscode-foreground);
        }

        .search-clear.visible {
            display: flex;
        }

        .toolbar-separator {
            width: 1px;
            height: 24px;
            background: var(--vscode-panel-border);
        }

        .icon-btn {
            background: none;
            border: none;
            padding: 6px;
            cursor: pointer;
            color: var(--vscode-foreground);
            border-radius: 3px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
            opacity: 0.7;
        }

        .icon-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
            opacity: 1;
        }

        .icon-btn:disabled {
            opacity: 0.3;
            cursor: not-allowed;
        }

        .icon-btn:disabled:hover {
            background: none;
        }

        .icon-btn.add {
            color: var(--vscode-button-background);
            opacity: 1;
        }

        .icon-btn.delete {
            color: #f14c4c;
            opacity: 0.5;
        }

        .icon-btn.delete.active {
            color: #f14c4c;
            opacity: 1;
        }

        .icon-btn.commit {
            color: #89d185;
            opacity: 0.5;
        }

        .icon-btn.commit.active {
            color: #89d185;
            opacity: 1;
        }

        .icon-btn.revert {
            color: #f9a825;
            opacity: 0.5;
        }

        .icon-btn.revert.active {
            color: #f9a825;
            opacity: 1;
        }

        .icon-btn.refresh {
            color: #b180d7;
            opacity: 1;
        }

        .icon-btn svg {
            width: 20px;
            height: 20px;
            fill: currentColor;
        }

        .toolbar-right {
            margin-left: auto;
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .pagination {
            display: flex;
            gap: 0px;
            align-items: center;
        }

        .page-number {
            min-width: 30px;
            text-align: center;
            font-size: 16px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .limit-container {
            display: flex;
            align-items: center;
            gap: 8px;
            padding-left: 12px;
            border-left: 1px solid var(--vscode-panel-border);
        }

        .limit-label {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }

        .limit-select {
            padding: 4px 8px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 3px;
            font-size: 13px;
            cursor: pointer;
        }

        .limit-select:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        button {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 13px;
            transition: background 0.2s;
        }

        button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        button.secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .info-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }

        .table-container {
            overflow: auto;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }

        th {
            background: var(--vscode-sideBar-background);
            padding: 10px;
            text-align: left;
            font-weight: 600;
            position: sticky;
            top: 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            white-space: nowrap;
            position: relative;
        }

        th.sortable {
            padding-right: 35px;
        }

        th.checkbox-col {
            width: 40px;
            text-align: center;
        }

        th.sortable {
            cursor: pointer;
            user-select: none;
            position: relative;
        }

        th.sortable:hover {
            background: var(--vscode-list-hoverBackground);
        }

        th.sortable .sort-icon {
            position: absolute;
            right: 8px;
            top: 50%;
            transform: translateY(-50%);
        }

        .sort-icon {
            display: inline-flex;
            flex-direction: column;
            opacity: 1;
            color: var(--vscode-foreground);
        }

        .sort-icon.active {
            opacity: 1;
            color: var(--vscode-focusBorder);
        }

        .sort-icon:hover {
            opacity: 0.6;
        }
        
        .sort-icon svg {
            width: 16px;
            height: 16px;
            fill: currentColor;
        }

        .sort-icon .sort-up {
            margin-bottom: -6px;
            display: block;
        }

        .sort-icon .sort-down {
            margin-top: -6px;
            display: block;
        }

        .sort-icon.asc .sort-down {
            display: none !important;
        }

        .sort-icon.desc .sort-up {
            display: none !important;
        }

        td {
            padding: 8px 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            border-right: 1px solid var(--vscode-panel-border);
        }

        td:last-child {
            border-right: none;
        }

        th {
            border-right: 1px solid var(--vscode-panel-border);
        }

        th:last-child {
            border-right: none;
        }

        td.checkbox-col {
            text-align: center;
        }

        tr:hover {
            background: var(--vscode-list-hoverBackground);
        }

        tr.selected {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }

        tr.modified {}

        td.modified {
            background: rgba(249, 168, 37, 0.2) !important;
        }

        tr.editing td {
            padding: 4px;
        }

        td.editable {
            cursor: pointer;
        }

        td.editable:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .cell-input {
            width: 100%;
            padding: 4px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-size: 13px;
            outline: none;
        }

        .cell-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }

        .cell-textarea {
            resize: vertical;
            min-height: 60px;
            font-family: var(--vscode-font-family);
        }

        select.cell-input {
            cursor: pointer;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
        }

        select.cell-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }

        input[type="date"].cell-input,
        input[type="time"].cell-input,
        input[type="datetime-local"].cell-input {
            color-scheme: dark;
        }

        input[type="date"].cell-input::-webkit-calendar-picker-indicator,
        input[type="time"].cell-input::-webkit-calendar-picker-indicator,
        input[type="datetime-local"].cell-input::-webkit-calendar-picker-indicator {
            filter: brightness(0) invert(1);
            cursor: pointer;
            opacity: 0.9;
        }

        input[type="date"].cell-input::-webkit-calendar-picker-indicator:hover,
        input[type="time"].cell-input::-webkit-calendar-picker-indicator:hover,
        input[type="datetime-local"].cell-input::-webkit-calendar-picker-indicator:hover {
            opacity: 1;
            filter: brightness(0) invert(1) brightness(1.2);
        }

        .pk-indicator {
            color: var(--vscode-symbolIcon-keyForeground);
            margin-right: 5px;
            display: inline-flex;
            align-items: center;
            vertical-align: middle;
            font-size: 10px;
        }

        .pk-indicator svg {
            width: 12px;
            height: 12px;
            fill: currentColor;
        }

        .unique-indicator {
            color: var(--vscode-charts-blue);
            margin-right: 5px;
            display: inline-flex;
            align-items: center;
            vertical-align: middle;
            font-size: 10px;
        }

        .identity-indicator {
            color: var(--vscode-charts-green);
            margin-right: 5px;
            display: inline-flex;
            align-items: center;
            vertical-align: middle;
            font-size: 12px;
            font-weight: bold;
        }

        .required-indicator {
            color: #f14c4c;
            margin-left: 3px;
            font-size: 14px;
        }

        .column-type {
            color: var(--vscode-descriptionForeground);
            font-weight: normal;
            margin-left: 5px;
            opacity: 0.7;
        }

        .null-value {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }

        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            justify-content: center;
            align-items: center;
            z-index: 1000;
        }

        .modal.show {
            display: flex;
        }

        .modal-content {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 20px;
            max-width: 600px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
        }

        .modal-header {
            margin-bottom: 20px;
            font-size: 16px;
            font-weight: 600;
        }

        .form-group {
            margin-bottom: 15px;
        }

        .form-group label {
            display: block;
            margin-bottom: 5px;
            font-size: 13px;
        }

        .form-group input,
        .form-group select {
            width: 100%;
            padding: 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-size: 13px;
        }

        .form-group input:focus,
        .form-group select:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }

        .form-group select {
            cursor: pointer;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
        }

        .form-group input[type="date"],
        .form-group input[type="time"],
        .form-group input[type="datetime-local"] {
            color-scheme: dark;
        }

        .form-group input[type="date"]::-webkit-calendar-picker-indicator,
        .form-group input[type="time"]::-webkit-calendar-picker-indicator,
        .form-group input[type="datetime-local"]::-webkit-calendar-picker-indicator {
            filter: brightness(0) invert(1);
            cursor: pointer;
            opacity: 0.9;
        }

        .form-group input[type="date"]::-webkit-calendar-picker-indicator:hover,
        .form-group input[type="time"]::-webkit-calendar-picker-indicator:hover,
        .form-group input[type="datetime-local"]::-webkit-calendar-picker-indicator:hover {
            opacity: 1;
            filter: brightness(0) invert(1) brightness(1.2);
        }

        .modal-actions {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <div class="search-container">
            <input type="text" class="search-box" id="searchInput" placeholder="Search..." value="${search || ''}">
            <button class="search-clear" id="searchClear" onclick="clearSearch()">×</button>
        </div>
        
        <div class="toolbar-separator"></div>
        
        <button class="icon-btn add" onclick="showAddModal()" title="Add Row">
            <svg viewBox="0 0 16 16">
                <path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="2" fill="none"/>
            </svg>
        </button>
        
        <button class="icon-btn commit" id="commitBtn" onclick="commitChanges()" disabled title="Commit Changes">
            <svg viewBox="0 0 16 16">
                <path d="M2 8l4 4 8-8" stroke="currentColor" stroke-width="2" fill="none"/>
            </svg>
        </button>
        
        <button class="icon-btn revert" id="revertBtn" onclick="revertChanges()" disabled title="Revert Changes">
            <svg viewBox="0 0 16 16">
                <path d="M2.5 2.5A6.5 6.5 0 0 1 8 1c3.9 0 7 3.1 7 7s-3.1 7-7 7c-3.2 0-5.8-2.1-6.7-5h1.5c.8 2 2.7 3.5 5.2 3.5 3 0 5.5-2.5 5.5-5.5S11 2.5 8 2.5c-1.5 0-2.9.6-3.9 1.7L6 6H1V1l1.5 1.5z"/>
            </svg>
        </button>
        
        <button class="icon-btn delete" id="deleteBtn" onclick="deleteSelected()" disabled title="Delete Selected">
            <svg viewBox="0 0 16 16">
                <path d="M5 3V1h6v2h4v2h-1v9c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V5H1V3h4zm1 2v7h1V5H6zm3 0v7h1V5H9z"/>
            </svg>
        </button>
        
        <div class="toolbar-separator"></div>
        
        <button class="icon-btn refresh" onclick="refresh()" title="Refresh">
            <svg viewBox="0 0 16 16">
                <path d="M13.5 2.5A6.5 6.5 0 0 0 8 1C4.1 1 1 4.1 1 8s3.1 7 7 7c3.2 0 5.8-2.1 6.7-5h-1.5c-.8 2-2.7 3.5-5.2 3.5-3 0-5.5-2.5-5.5-5.5S5 2.5 8 2.5c1.5 0 2.9.6 3.9 1.7L10 6h5V1l-1.5 1.5z"/>
            </svg>
        </button>
        
        <div class="toolbar-right">
            <div class="pagination">
                <button class="icon-btn" onclick="goToPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''} title="Previous Page">
                    <svg viewBox="0 0 16 16">
                        <path d="M10 2L4 8l6 6" stroke="currentColor" stroke-width="2" fill="none"/>
                    </svg>
                </button>
                
                <span class="page-number">${currentPage}</span>
                
                <button class="icon-btn" onclick="goToPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''} title="Next Page">
                    <svg viewBox="0 0 16 16">
                        <path d="M6 2l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none"/>
                    </svg>
                </button>
            </div>
            
            <div class="limit-container">
                <span class="limit-label">Rows:</span>
                <select class="limit-select" id="limitSelect" onchange="changeLimit()" title="Rows per page">
                    <option value="5" ${limit === 5 ? 'selected' : ''}>5</option>
                    <option value="10" ${limit === 10 ? 'selected' : ''}>10</option>
                    <option value="25" ${limit === 25 ? 'selected' : ''}>25</option>
                    <option value="50" ${limit === 50 ? 'selected' : ''}>50</option>
                    <option value="100" ${limit === 100 ? 'selected' : ''}>100</option>
                </select>
            </div>
        </div>
    </div>

    <div class="table-container">
        <table>
            <thead>
                <tr>
                    <th class="checkbox-col">
                        <input type="checkbox" id="selectAll" onchange="toggleSelectAll(this)">
                    </th>
                    ${columns.map((col, colIndex) => `
                        <th class="sortable" onclick="sortByColumn('${col.column_name}', ${colIndex})">
                            ${primaryKeys.includes(col.column_name) ? '<span class="pk-indicator">🔑</span>' : ''}${uniqueKeys.includes(col.column_name) ? '<span class="unique-indicator">🔐</span>' : ''}${identityColumns.includes(col.column_name) ? '<span class="identity-indicator">↻</span>' : ''}${col.column_name}${col.is_nullable === 'NO' ? '<span class="required-indicator">*</span>' : ''}
                            <span class="column-type">(${col.data_type})</span>
                            <span class="sort-icon" data-column="${col.column_name}">
                                <svg class="sort-up" viewBox="0 0 16 16">
                                    <path d="M8 4 L4 10 L12 10 Z"/>
                                </svg>
                                <svg class="sort-down" viewBox="0 0 16 16">
                                    <path d="M8 12 L4 6 L12 6 Z"/>
                                </svg>
                            </span>
                        </th>
                    `).join('')}
                </tr>
            </thead>
            <tbody id="tableBody">
                ${rows.map((row, rowIndex) => `
                    <tr data-row-index="${rowIndex}" data-row='${JSON.stringify(row).replace(/'/g, "&#39;")}'>
                        <td class="checkbox-col">
                            <input type="checkbox" class="row-checkbox" onchange="updateSelectedCount()">
                        </td>
                        ${columns.map(col => `
                            <td class="editable" ondblclick="editCell(this, ${rowIndex}, '${col.column_name}')">
                                ${row[col.column_name] === null 
                                    ? '<span class="null-value">NULL</span>' 
                                    : this.escapeHtml(String(row[col.column_name]))}
                            </td>
                        `).join('')}
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>

    <div class="modal" id="addModal">
        <div class="modal-content">
            <div class="modal-header">Add New Row</div>
            <form id="addForm">
                ${columns.map(col => {
                    const isPrimaryKey = primaryKeys.includes(col.column_name);
                    const isUnique = uniqueKeys.includes(col.column_name);
                    const isIdentity = identityColumns.includes(col.column_name);
                    const isRequired = col.is_nullable === 'NO' && !col.column_default && !isPrimaryKey;
                    const dataType = col.data_type.toLowerCase();
                    
                    // Determine input type and placeholder
                    let inputType = 'text';
                    let placeholder = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
                    let step = '';
                    
                    if (dataType === 'boolean' || dataType === 'bool') {
                        inputType = 'select';
                        placeholder = '';
                    } else if (dataType.includes('int') || dataType === 'smallint' || dataType === 'bigint' || dataType === 'serial' || dataType === 'bigserial') {
                        inputType = 'number';
                        step = '1';
                        placeholder = col.is_nullable === 'YES' ? 'NULL' : 'e.g., 123';
                    } else if (dataType.includes('numeric') || dataType.includes('decimal') || dataType.includes('float') || dataType.includes('double') || dataType === 'real' || dataType === 'money') {
                        inputType = 'number';
                        step = 'any';
                        placeholder = col.is_nullable === 'YES' ? 'NULL' : 'e.g., 123.45';
                    } else if (dataType === 'date') {
                        inputType = 'date';
                        placeholder = col.is_nullable === 'YES' ? 'NULL' : '';
                    } else if (dataType.includes('timestamp') || dataType === 'datetime') {
                        inputType = 'datetime-local';
                        placeholder = col.is_nullable === 'YES' ? 'NULL' : '';
                    } else if (dataType === 'time') {
                        inputType = 'time';
                        placeholder = col.is_nullable === 'YES' ? 'NULL' : '';
                    } else if (dataType === 'uuid') {
                        placeholder = col.is_nullable === 'YES' ? 'NULL' : 'e.g., 550e8400-e29b-41d4-a716-446655440000';
                    } else if (dataType === 'text' || dataType.includes('char')) {
                        placeholder = col.is_nullable === 'YES' ? 'NULL' : 'e.g., Sample text';
                    }
                    
                    return `
                    <div class="form-group">
                        <label>
                            ${isPrimaryKey ? '<span class="pk-indicator">🔑</span>' : ''}${isUnique ? '<span class="unique-indicator">🔐</span>' : ''}${isIdentity ? '<span class="identity-indicator">↻</span>' : ''}${col.column_name}
                            ${isRequired ? '<span style="color: red;">*</span>' : ''}
                            <span style="color: var(--vscode-descriptionForeground); font-size: 11px;">
                                (${col.data_type})
                            </span>
                        </label>
                        ${inputType === 'select' ? `
                            <select name="${col.column_name}" ${isRequired ? 'required' : ''}>
                                ${col.is_nullable === 'YES' ? '<option value="">NULL</option>' : ''}
                                <option value="true">true</option>
                                <option value="false">false</option>
                            </select>
                        ` : inputType === 'number' ? `
                            <input 
                                type="number"
                                step="${step}"
                                name="${col.column_name}"
                                ${isRequired ? 'required' : ''}
                                placeholder="${placeholder}"
                            >
                        ` : inputType === 'date' || inputType === 'time' || inputType === 'datetime-local' ? `
                            <input 
                                type="${inputType}"
                                name="${col.column_name}"
                                ${isRequired ? 'required' : ''}
                                placeholder="${placeholder}"
                            >
                        ` : `
                            <input 
                                type="text"
                                name="${col.column_name}"
                                ${isRequired ? 'required' : ''}
                                placeholder="${placeholder}"
                            >
                        `}
                    </div>
                    `;
                }).join('')}
                <div class="modal-actions">
                    <button type="submit">Add</button>
                    <button type="button" class="secondary" onclick="hideAddModal()">Cancel</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let limit = ${limit};
        let currentOffset = ${offset};
        let pendingChanges = new Map(); // Map<rowIndex, {originalRow, changes}>
        let editingCell = null;
        let currentSort = { 
            column: ${sortColumn ? `'${sortColumn}'` : 'null'}, 
            direction: ${sortDirection ? `'${sortDirection}'` : 'null'} 
        }; // null, 'asc', 'desc'

        // Update search clear button visibility
        function updateSearchClearButton() {
            const searchInput = document.getElementById('searchInput');
            const clearBtn = document.getElementById('searchClear');
            if (searchInput.value) {
                clearBtn.classList.add('visible');
            } else {
                clearBtn.classList.remove('visible');
            }
        }

        function updateCommitRevertButtons() {
            const commitBtn = document.getElementById('commitBtn');
            const revertBtn = document.getElementById('revertBtn');
            
            if (pendingChanges.size > 0) {
                commitBtn.classList.add('active');
                commitBtn.disabled = false;
                revertBtn.classList.add('active');
                revertBtn.disabled = false;
            } else {
                commitBtn.classList.remove('active');
                commitBtn.disabled = true;
                revertBtn.classList.remove('active');
                revertBtn.disabled = true;
            }
        }

        function editCell(cell, rowIndex, columnName) {
            if (editingCell) {
                saveCell();
            }

            const row = cell.closest('tr');
            const originalRow = JSON.parse(row.getAttribute('data-row'));
            const currentValue = originalRow[columnName];
            
            // Find column info to determine data type
            const columns = ${JSON.stringify(columns)};
            const columnInfo = columns.find(col => col.column_name === columnName);
            const dataType = columnInfo ? columnInfo.data_type.toLowerCase() : 'text';
            const isNullable = columnInfo ? columnInfo.is_nullable === 'YES' : true;
            
            editingCell = {
                cell: cell,
                rowIndex: rowIndex,
                columnName: columnName,
                originalValue: currentValue,
                dataType: dataType,
                isNullable: isNullable
            };

            let inputHtml = '';
            
            // Boolean type - dropdown
            if (dataType === 'boolean' || dataType === 'bool') {
                const trueSelected = currentValue === true || currentValue === 'true' || currentValue === 't';
                const falseSelected = currentValue === false || currentValue === 'false' || currentValue === 'f';
                const nullSelected = currentValue === null;
                
                inputHtml = \`<select class="cell-input" onblur="saveCell()" onkeydown="handleCellKeydown(event)">
                    \${isNullable ? \`<option value="NULL" \${nullSelected ? 'selected' : ''}>NULL</option>\` : ''}
                    <option value="true" \${trueSelected ? 'selected' : ''}>true</option>
                    <option value="false" \${falseSelected ? 'selected' : ''}>false</option>
                </select>\`;
            }
            // Integer types - number input
            else if (dataType.includes('int') || dataType === 'smallint' || dataType === 'bigint' || dataType === 'serial' || dataType === 'bigserial') {
                const value = currentValue === null ? '' : String(currentValue);
                inputHtml = \`<input type="number" step="1" class="cell-input" 
                    value="\${value.replace(/"/g, '&quot;')}" 
                    onblur="saveCell()" 
                    onkeydown="handleCellKeydown(event)"
                    \${isNullable ? 'placeholder="NULL"' : ''}>\`;
            }
            // Numeric/Decimal types - number input with decimals
            else if (dataType.includes('numeric') || dataType.includes('decimal') || dataType.includes('float') || dataType.includes('double') || dataType === 'real' || dataType === 'money') {
                const value = currentValue === null ? '' : String(currentValue);
                inputHtml = \`<input type="number" step="any" class="cell-input" 
                    value="\${value.replace(/"/g, '&quot;')}" 
                    onblur="saveCell()" 
                    onkeydown="handleCellKeydown(event)"
                    \${isNullable ? 'placeholder="NULL"' : ''}>\`;
            }
            // Date type - date input
            else if (dataType === 'date') {
                let value = '';
                if (currentValue !== null) {
                    // Format date as YYYY-MM-DD for input
                    const date = new Date(currentValue);
                    if (!isNaN(date.getTime())) {
                        value = date.toISOString().split('T')[0];
                    }
                }
                inputHtml = \`<input type="date" class="cell-input" 
                    value="\${value}" 
                    onblur="saveCell()" 
                    onkeydown="handleCellKeydown(event)"
                    \${isNullable ? 'placeholder="NULL"' : ''}>\`;
            }
            // Timestamp/DateTime types - datetime-local input
            else if (dataType.includes('timestamp') || dataType === 'datetime') {
                let value = '';
                if (currentValue !== null) {
                    // Format datetime as YYYY-MM-DDTHH:mm for input
                    const date = new Date(currentValue);
                    if (!isNaN(date.getTime())) {
                        // Get local ISO string and remove seconds and timezone
                        const offset = date.getTimezoneOffset();
                        const localDate = new Date(date.getTime() - (offset * 60 * 1000));
                        value = localDate.toISOString().slice(0, 16);
                    }
                }
                inputHtml = \`<input type="datetime-local" class="cell-input" 
                    value="\${value}" 
                    onblur="saveCell()" 
                    onkeydown="handleCellKeydown(event)"
                    \${isNullable ? 'placeholder="NULL"' : ''}>\`;
            }
            // Time type - time input
            else if (dataType === 'time') {
                let value = '';
                if (currentValue !== null) {
                    value = String(currentValue).substring(0, 5); // Get HH:mm
                }
                inputHtml = \`<input type="time" class="cell-input" 
                    value="\${value}" 
                    onblur="saveCell()" 
                    onkeydown="handleCellKeydown(event)"
                    \${isNullable ? 'placeholder="NULL"' : ''}>\`;
            }
            // Text types - text input or textarea for long text
            else {
                const value = currentValue === null ? '' : String(currentValue);
                const isLongText = dataType === 'text' || dataType.includes('char');
                
                if (isLongText && value.length > 50) {
                    inputHtml = \`<textarea class="cell-input cell-textarea" 
                        onblur="saveCell()" 
                        onkeydown="handleCellKeydown(event)"
                        \${isNullable ? 'placeholder="NULL"' : ''}
                        rows="3">\${value.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>\`;
                } else {
                    inputHtml = \`<input type="text" class="cell-input" 
                        value="\${value.replace(/"/g, '&quot;')}" 
                        onblur="saveCell()" 
                        onkeydown="handleCellKeydown(event)"
                        \${isNullable ? 'placeholder="NULL"' : ''}>\`;
                }
            }
            
            cell.innerHTML = inputHtml;
            
            const input = cell.querySelector('.cell-input, .cell-textarea');
            input.focus();
            if (input.select) {
                input.select();
            }
        }

        function handleCellKeydown(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                saveCell();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelCellEdit();
            }
        }

        function saveCell() {
            if (!editingCell) return;

            const { cell, rowIndex, columnName, originalValue, dataType, isNullable } = editingCell;
            const input = cell.querySelector('.cell-input, .cell-textarea, select');
            if (!input) return;

            let newValue = input.value;
            
            // Handle NULL values
            if (newValue === '' && isNullable) {
                newValue = null;
            } else if (newValue === 'NULL' && isNullable) {
                newValue = null;
            } else if (newValue === '') {
                // If not nullable and empty, keep original value
                if (!isNullable) {
                    cancelCellEdit();
                    return;
                }
            } else {
                // Parse value based on data type
                if (dataType === 'boolean' || dataType === 'bool') {
                    if (newValue === 'NULL') {
                        newValue = null;
                    } else {
                        newValue = newValue === 'true' || newValue === 't' || newValue === '1';
                    }
                } else if (dataType.includes('int') || dataType === 'smallint' || dataType === 'bigint' || dataType === 'serial' || dataType === 'bigserial') {
                    newValue = newValue === '' ? null : parseInt(newValue, 10);
                } else if (dataType.includes('numeric') || dataType.includes('decimal') || dataType.includes('float') || dataType.includes('double') || dataType === 'real' || dataType === 'money') {
                    newValue = newValue === '' ? null : parseFloat(newValue);
                }
                // For date, time, timestamp, and text types, keep as string
            }
            
            const row = cell.closest('tr');
            const originalRow = JSON.parse(row.getAttribute('data-row'));

            // Update cell display
            if (newValue === null) {
                cell.innerHTML = '<span class="null-value">NULL</span>';
            } else if (dataType === 'boolean' || dataType === 'bool') {
                cell.textContent = newValue ? 'true' : 'false';
            } else {
                cell.textContent = String(newValue);
            }

            // Track changes
            if (newValue !== originalValue) {
                if (!pendingChanges.has(rowIndex)) {
                    pendingChanges.set(rowIndex, {
                        originalRow: originalRow,
                        changes: {}
                    });
                }
                pendingChanges.get(rowIndex).changes[columnName] = newValue;
                cell.classList.add('modified');
            } else {
                // If reverting to original, remove from changes
                if (pendingChanges.has(rowIndex)) {
                    delete pendingChanges.get(rowIndex).changes[columnName];
                    if (Object.keys(pendingChanges.get(rowIndex).changes).length === 0) {
                        pendingChanges.delete(rowIndex);
                    }
                }
                cell.classList.remove('modified');
            }

            editingCell = null;
            updateCommitRevertButtons();
        }

        function cancelCellEdit() {
            if (!editingCell) return;

            const { cell, originalValue } = editingCell;
            
            if (originalValue === null) {
                cell.innerHTML = '<span class="null-value">NULL</span>';
            } else {
                cell.textContent = originalValue;
            }

            editingCell = null;
        }

        function commitChanges() {
            if (pendingChanges.size === 0) return;

            pendingChanges.forEach((data, rowIndex) => {
                vscode.postMessage({
                    command: 'update',
                    row: data.originalRow,
                    changes: data.changes
                });
            });

            pendingChanges.clear();
            updateCommitRevertButtons();
        }

        function revertChanges() {
            if (pendingChanges.size === 0) return;

            pendingChanges.forEach((data, rowIndex) => {
                const row = document.querySelector(\`tr[data-row-index="\${rowIndex}"]\`);
                if (row) {
                    // Restore original values visually
                    const originalRow = data.originalRow;
                    const cells = row.querySelectorAll('td.editable');
                    const columns = ${JSON.stringify(columns.map(c => c.column_name))};
                    
                    cells.forEach((cell, index) => {
                        const columnName = columns[index];
                        const originalValue = originalRow[columnName];
                        
                        if (originalValue === null) {
                            cell.innerHTML = '<span class="null-value">NULL</span>';
                        } else {
                            cell.textContent = originalValue;
                        }
                        
                        // Remove modified class from cell
                        cell.classList.remove('modified');
                    });
                }
            });

            pendingChanges.clear();
            updateCommitRevertButtons();
        }

        function sortByColumn(columnName, columnIndex) {
            // Determine new sort direction
            let newDirection;
            if (currentSort.column === columnName) {
                // Same column - cycle through: null -> asc -> desc -> null
                if (currentSort.direction === null) {
                    newDirection = 'asc';
                } else if (currentSort.direction === 'asc') {
                    newDirection = 'desc';
                } else {
                    newDirection = null;
                }
            } else {
                // Different column - reset previous column and start with asc
                newDirection = 'asc';
            }

            // Update current sort state
            currentSort.column = newDirection === null ? null : columnName;
            currentSort.direction = newDirection;

            // Update all sort icons - remove active state from all
            document.querySelectorAll('.sort-icon').forEach(icon => {
                icon.classList.remove('active', 'asc', 'desc');
            });

            // Update the clicked column's icon
            if (newDirection !== null) {
                const sortIcon = document.querySelector(\`.sort-icon[data-column="\${columnName}"]\`);
                if (sortIcon) {
                    sortIcon.classList.add('active', newDirection);
                }
            }

            // Send query with sort parameters
            const searchValue = document.getElementById('searchInput').value;
            vscode.postMessage({
                command: 'query',
                search: searchValue || undefined,
                limit: limit,
                offset: currentOffset,
                sortColumn: currentSort.column,
                sortDirection: currentSort.direction
            });
        }

        // Apply sort state on page load
        function applySortState() {
            if (currentSort.column && currentSort.direction) {
                const sortIcon = document.querySelector(\`.sort-icon[data-column="\${currentSort.column}"]\`);
                if (sortIcon) {
                    sortIcon.classList.add('active', currentSort.direction);
                }
            }
        }

        // Call applySortState when the page loads
        applySortState();

        function search() {
            const searchValue = document.getElementById('searchInput').value;
            vscode.postMessage({
                command: 'query',
                search: searchValue,
                limit: limit,
                offset: 0,
                sortColumn: currentSort.column,
                sortDirection: currentSort.direction
            });
        }

        function clearSearch() {
            document.getElementById('searchInput').value = '';
            updateSearchClearButton();
            search();
        }

        function refresh() {
            // Check if there are pending changes
            if (pendingChanges.size > 0) {
                vscode.postMessage({
                    command: 'checkPendingChanges',
                    hasPendingChanges: true
                });
            } else {
                // No pending changes, just refresh
                const searchValue = document.getElementById('searchInput').value;
                vscode.postMessage({
                    command: 'query',
                    search: searchValue || undefined,
                    limit: limit,
                    offset: currentOffset,
                    sortColumn: currentSort.column,
                    sortDirection: currentSort.direction
                });
            }
        }

        function changeLimit() {
            limit = parseInt(document.getElementById('limitSelect').value);
            const searchValue = document.getElementById('searchInput').value;
            vscode.postMessage({
                command: 'query',
                search: searchValue || undefined,
                limit: limit,
                offset: 0,
                sortColumn: currentSort.column,
                sortDirection: currentSort.direction
            });
        }

        function goToPage(page) {
            const newOffset = (page - 1) * limit;
            const searchValue = document.getElementById('searchInput').value;
            vscode.postMessage({
                command: 'query',
                search: searchValue || undefined,
                limit: limit,
                offset: newOffset,
                sortColumn: currentSort.column,
                sortDirection: currentSort.direction
            });
        }

        function toggleSelectAll(checkbox) {
            const checkboxes = document.querySelectorAll('.row-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = checkbox.checked;
                if (checkbox.checked) {
                    cb.closest('tr').classList.add('selected');
                } else {
                    cb.closest('tr').classList.remove('selected');
                }
            });
            updateSelectedCount();
        }

        function updateSelectedCount() {
            const selected = document.querySelectorAll('.row-checkbox:checked').length;
            const deleteBtn = document.getElementById('deleteBtn');
            
            if (selected > 0) {
                deleteBtn.classList.add('active');
                deleteBtn.disabled = false;
            } else {
                deleteBtn.classList.remove('active');
                deleteBtn.disabled = true;
            }

            document.querySelectorAll('.row-checkbox').forEach(cb => {
                if (cb.checked) {
                    cb.closest('tr').classList.add('selected');
                } else {
                    cb.closest('tr').classList.remove('selected');
                }
            });
        }

        function deleteRow(index) {
            const row = document.querySelector(\`tr[data-row-index="\${index}"]\`);
            const rowData = JSON.parse(row.getAttribute('data-row'));
            
            vscode.postMessage({
                command: 'delete',
                row: rowData
            });
        }

        function deleteSelected() {
            const selected = document.querySelectorAll('.row-checkbox:checked');
            if (selected.length === 0) return;
            
            const rows = [];
            selected.forEach(checkbox => {
                const row = checkbox.closest('tr');
                const rowData = JSON.parse(row.getAttribute('data-row'));
                rows.push(rowData);
            });
            
            vscode.postMessage({
                command: 'deleteMultiple',
                rows: rows
            });
        }

        function showAddModal() {
            document.getElementById('addModal').classList.add('show');
        }

        function hideAddModal() {
            document.getElementById('addModal').classList.remove('show');
            document.getElementById('addForm').reset();
        }

        document.getElementById('addForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const row = {};
            
            formData.forEach((value, key) => {
                row[key] = value === '' ? null : value;
            });

            vscode.postMessage({
                command: 'insert',
                row: row
            });

            hideAddModal();
        });

        // Search input handlers
        document.getElementById('searchInput').addEventListener('input', (e) => {
            updateSearchClearButton();
        });

        document.getElementById('searchInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                search();
            }
        });

        // Initialize search clear button visibility
        updateSearchClearButton();

        // Close modal on outside click
        document.getElementById('addModal').addEventListener('click', (e) => {
            if (e.target.id === 'addModal') {
                hideAddModal();
            }
        });

        // Listen for messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'commitFromBackend':
                    commitChanges();
                    // Refresh after commit
                    const searchValue = document.getElementById('searchInput').value;
                    vscode.postMessage({
                        command: 'query',
                        search: searchValue || undefined,
                        limit: limit,
                        offset: currentOffset,
                        sortColumn: currentSort.column,
                        sortDirection: currentSort.direction
                    });
                    break;
                case 'revertFromBackend':
                    revertChanges();
                    // Refresh after revert
                    const searchValueRevert = document.getElementById('searchInput').value;
                    vscode.postMessage({
                        command: 'query',
                        search: searchValueRevert || undefined,
                        limit: limit,
                        offset: currentOffset,
                        sortColumn: currentSort.column,
                        sortDirection: currentSort.direction
                    });
                    break;
            }
        });
    </script>
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        const map: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }
}