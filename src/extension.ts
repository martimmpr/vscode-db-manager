import * as vscode from 'vscode';
import { DatabaseExplorer } from './databaseExplorer';
import { TableViewer } from './tableViewer';
import { Connection } from './types';
import { DatabaseAdapterFactory, DatabaseDetector } from './database';

export function activate(context: vscode.ExtensionContext) {
    const databaseExplorer = new DatabaseExplorer(context);
    const tableViewer = new TableViewer(context);

    let addConnection = vscode.commands.registerCommand('databaseExplorer.addConnection', async () => {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter connection name',
            placeHolder: 'My Database'
        });

        if (!name) return;

        const host = await vscode.window.showInputBox({
            prompt: 'Enter host',
            placeHolder: 'localhost',
            value: 'localhost'
        });

        if (!host) return;

        const port = await vscode.window.showInputBox({
            prompt: 'Enter port',
            placeHolder: '5432 (PostgreSQL) or 3306 (MySQL/MariaDB)',
            value: '5432'
        });

        if (!port) return;

        const username = await vscode.window.showInputBox({
            prompt: 'Enter username',
            placeHolder: 'root'
        });

        if (!username) return;

        const password = await vscode.window.showInputBox({
            prompt: 'Enter password',
            password: true
        });

        if (!password) {
            vscode.window.showErrorMessage('Password is required!');
            return;
        }

        // Show progress while detecting database type
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${name}...`,
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ message: 'Detecting database type...' });
                
                // Attempt to detect database type
                const detectedType = await DatabaseDetector.detectDatabaseType(
                    host,
                    parseInt(port),
                    username.trim(),
                    password
                );

                if (!detectedType) {
                    vscode.window.showErrorMessage(
                        'Could not detect database type or failed to connect. Please check your credentials and try again.'
                    );
                    return;
                }

                progress.report({ message: `Detected ${detectedType} database` });

                const connection: Connection = {
                    name,
                    type: detectedType,
                    host,
                    port: parseInt(port),
                    username: username.trim(),
                    password
                };

                // Test connection one more time with the detected type
                const adapter = DatabaseAdapterFactory.createAdapter(connection);
                await adapter.testConnection();
                await adapter.close();

                await databaseExplorer.addConnection(connection);
                vscode.window.showInformationMessage(
                    `${detectedType} connection "${name}" added successfully!`
                );
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                console.error('Connection error:', errorMessage);
                vscode.window.showErrorMessage(`Failed to connect: ${errorMessage}`);
            }
        });
    });

    let refreshConnection = vscode.commands.registerCommand('databaseExplorer.refreshConnection', async (item: any) => {
        if (!item?.connection) return;
        
        try {
            databaseExplorer.refreshConnection(item.connection);
            vscode.window.showInformationMessage(`Connection "${item.connection.name}" refreshed successfully!`);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to refresh connection: ${errorMessage}`);
        }
    });

    let filterDatabases = vscode.commands.registerCommand('databaseExplorer.filterDatabases', async (item: any) => {
        if (!item?.connection) return;

        try {
            const adapter = DatabaseAdapterFactory.createAdapter(item.connection);
            const databases = await adapter.getDatabases();
            await adapter.close();
            
            const quickPick = vscode.window.createQuickPick();
            quickPick.canSelectMany = true;
            quickPick.title = 'Select Databases to Show';
            quickPick.placeholder = 'Leave empty to show all databases';
            
            quickPick.items = databases.map((db: string) => ({
                label: db,
                picked: item.connection.selectedDatabases ? 
                    item.connection.selectedDatabases.includes(db) : false
            }));

            quickPick.onDidAccept(async () => {
                const selectedDatabases = quickPick.selectedItems.map(item => item.label);
                await databaseExplorer.updateDatabaseFilter(item.connection, selectedDatabases);
                quickPick.dispose();
            });

            quickPick.show();
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to fetch databases: ${errorMessage}`);
        }
    });

    let editConnection = vscode.commands.registerCommand('databaseExplorer.editConnection', async (item: any) => {
        if (!item?.connection) return;

        const name = await vscode.window.showInputBox({
            prompt: 'Enter connection name',
            value: item.connection.name
        });

        if (!name) return;

        const host = await vscode.window.showInputBox({
            prompt: 'Enter host',
            value: item.connection.host
        });

        if (!host) return;

        const port = await vscode.window.showInputBox({
            prompt: 'Enter port',
            value: item.connection.port.toString()
        });

        if (!port) return;

        const username = await vscode.window.showInputBox({
            prompt: 'Enter username',
            value: item.connection.username
        });

        if (!username) return;

        const password = await vscode.window.showInputBox({
            prompt: 'Enter password',
            password: true,
            value: item.connection.password
        });

        if (!password) {
            vscode.window.showErrorMessage('Password is required!');
            return;
        }

        // Show progress while detecting database type
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Updating connection ${name}...`,
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ message: 'Detecting database type...' });
                
                // Attempt to detect database type
                const detectedType = await DatabaseDetector.detectDatabaseType(
                    host,
                    parseInt(port),
                    username.trim(),
                    password
                );

                if (!detectedType) {
                    vscode.window.showErrorMessage(
                        'Could not detect database type or failed to connect. Please check your credentials and try again.'
                    );
                    return;
                }

                progress.report({ message: `Detected ${detectedType} database` });

                const newConnection: Connection = {
                    name,
                    type: detectedType,
                    host,
                    port: parseInt(port),
                    username: username.trim(),
                    password
                };

                // Test connection
                const adapter = DatabaseAdapterFactory.createAdapter(newConnection);
                await adapter.testConnection();
                await adapter.close();

                await databaseExplorer.editConnection(item.connection, newConnection);
                vscode.window.showInformationMessage(
                    `${detectedType} connection "${name}" updated successfully!`
                );
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                vscode.window.showErrorMessage(`Failed to update connection: ${errorMessage}`);
            }
        });
    });

    let removeConnection = vscode.commands.registerCommand('databaseExplorer.removeConnection', async (item: any) => {
        if (!item?.connection) return;

        const answer = await vscode.window.showWarningMessage(
            `Are you sure you want to remove the connection "${item.connection.name}"?`,
            'Yes',
            'No'
        );

        if (answer === 'Yes') {
            await databaseExplorer.removeConnection(item.connection);
            vscode.window.showInformationMessage('Connection removed successfully!');
        }
    });

    let openTable = vscode.commands.registerCommand('databaseExplorer.openTable', async (item: any) => {
        if (!item?.connection || !item?.database || !item?.table) {
            vscode.window.showErrorMessage('Invalid table item');
            return;
        }

        await tableViewer.openTable(item.connection, item.database, item.table);
    });

    let addTable = vscode.commands.registerCommand('databaseExplorer.addTable', async (item: any) => {
        if (!item?.connection || !item?.database) return;

        const tableName = await vscode.window.showInputBox({
            prompt: 'Enter table name',
            placeHolder: 'my_table'
        });

        if (!tableName) return;

        const columns: Array<{name: string, type: string, constraints: string[]}> = [];
        let addingColumns = true;
        let cancelled = false;

        while (addingColumns && !cancelled) {
            const columnName = await vscode.window.showInputBox({
                prompt: `Enter column name (leave empty to finish) - Table: ${tableName}`,
                placeHolder: 'column_name'
            });

            // If user presses ESC or closes, columnName will be undefined
            if (columnName === undefined) {
                // User cancelled - abort the whole operation
                cancelled = true;
                break;
            }

            // If empty string, user wants to finish adding columns
            if (columnName === '') {
                addingColumns = false;
                break;
            }

            const columnType = await vscode.window.showQuickPick([
                'bigint', 'bigserial', 'bit', 'boolean', 'char', 'character varying', 
                'date', 'double precision', 'integer', 'json', 'jsonb', 'numeric',
                'real', 'serial', 'smallint', 'smallserial', 'text', 
                'timestamp with time zone', 'timestamp without time zone', 'uuid'
            ], {
                placeHolder: 'Select column type'
            });

            if (!columnType) {
                // User cancelled
                cancelled = true;
                break;
            }

            const constraints = await vscode.window.showQuickPick(
                [
                    { label: 'PRIMARY KEY', picked: false },
                    { label: 'NOT NULL', picked: false },
                    { label: 'UNIQUE', picked: false },
                    { label: 'AUTO INCREMENT', picked: false }
                ],
                {
                    canPickMany: true,
                    placeHolder: 'Select constraints (optional, press ESC to skip)'
                }
            );

            // If constraints is undefined, user pressed ESC
            if (constraints === undefined) {
                cancelled = true;
                break;
            }

            const constraintStrings = constraints.map(c => {
                if (c.label === 'AUTO INCREMENT') {
                    return 'GENERATED ALWAYS AS IDENTITY';
                }
                return c.label;
            });

            columns.push({
                name: columnName,
                type: columnType,
                constraints: constraintStrings
            });
        }

        // If cancelled or no columns added, abort
        if (cancelled) {
            return;
        }

        if (columns.length === 0) {
            return;
        }

        try {
            await databaseExplorer.createTable(item.connection, item.database, tableName, columns);
            vscode.window.showInformationMessage(`Table "${tableName}" created successfully!`);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to create table: ${errorMessage}`);
        }
    });

    let refreshDatabase = vscode.commands.registerCommand('databaseExplorer.refreshDatabase', async (item: any) => {
        if (!item?.connection || !item?.database) return;
        
        try {
            await databaseExplorer.refreshDatabase(item.connection, item.database);
            vscode.window.showInformationMessage(`Database "${item.database}" refreshed successfully!`);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to refresh database: ${errorMessage}`);
        }
    });

    let filterTables = vscode.commands.registerCommand('databaseExplorer.filterTables', async (item: any) => {
        if (!item?.connection || !item?.database) return;

        try {
            const adapter = DatabaseAdapterFactory.createAdapter(item.connection);
            const tables = await adapter.getTables(item.database);
            await adapter.close();
            
            const quickPick = vscode.window.createQuickPick();
            quickPick.canSelectMany = true;
            quickPick.title = 'Select Tables to Show';
            quickPick.placeholder = 'Leave empty to show all tables';
            
            quickPick.items = tables.map((table: string) => ({
                label: table,
                picked: item.connection.selectedTables && 
                        item.connection.selectedTables[item.database] ? 
                    item.connection.selectedTables[item.database].includes(table) : false
            }));

            quickPick.onDidAccept(async () => {
                const selectedTables = quickPick.selectedItems.map(item => item.label);
                await databaseExplorer.updateTableFilter(item.connection, item.database, selectedTables);
                quickPick.dispose();
            });

            quickPick.show();
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to fetch tables: ${errorMessage}`);
        }
    });

    let editTable = vscode.commands.registerCommand('databaseExplorer.editTable', async (item: any) => {
        if (!item?.connection || !item?.database || !item?.table) return;

        // Build options based on database type
        const options = [
            { label: 'Rename Table', value: 'rename' },
            { label: 'Add Column', value: 'add' },
            { label: 'Remove Column', value: 'remove' }
        ];

        // Only add "Reorder Columns" option for PostgreSQL
        if (item.connection.type === 'PostgreSQL') {
            options.push({ label: 'Reorder Columns', value: 'reorder' });
        }

        const action = await vscode.window.showQuickPick(options, {
            placeHolder: `Edit table "${item.table}"`
        });

        if (!action) return;

        if (action.value === 'rename') {
            // Rename table
            const newTableName = await vscode.window.showInputBox({
                prompt: 'Enter new table name',
                value: item.table,
                placeHolder: 'new_table_name'
            });

            if (!newTableName || newTableName === item.table) return;

            try {
                await databaseExplorer.renameTable(
                    item.connection,
                    item.database,
                    item.table,
                    newTableName
                );
                vscode.window.showInformationMessage(`Table renamed from "${item.table}" to "${newTableName}" successfully!`);
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                vscode.window.showErrorMessage(`Failed to rename table: ${errorMessage}`);
            }
        } else if (action.value === 'reorder') {
            // Reorder columns
            try {
                const adapter = DatabaseAdapterFactory.createAdapter(item.connection);
                const columnInfos = await adapter.getColumns(item.database, item.table);
                await adapter.close();

                if (columnInfos.length < 2) {
                    vscode.window.showInformationMessage('Table must have at least 2 columns to reorder.');
                    return;
                }

                const columns = columnInfos.map(row => ({
                    label: row.column_name,
                    description: `${row.data_type} ${row.is_nullable === 'NO' ? '(NOT NULL)' : ''}`
                }));

                const columnToMove = await vscode.window.showQuickPick(columns, {
                    placeHolder: 'Select column to move'
                });

                if (!columnToMove) return;

                const direction = await vscode.window.showQuickPick([
                    { label: 'Move to First', value: 'first' },
                    { label: 'Move After...', value: 'after' }
                ], {
                    placeHolder: `Move "${columnToMove.label}"`
                });

                if (!direction) return;

                let afterColumn: string | undefined;
                if (direction.value === 'after') {
                    const otherColumns = columns.filter(c => c.label !== columnToMove.label);
                    const selectedColumn = await vscode.window.showQuickPick(otherColumns, {
                        placeHolder: `Move "${columnToMove.label}" after...`
                    });

                    if (!selectedColumn) return;
                    afterColumn = selectedColumn.label;
                }

                await databaseExplorer.reorderColumn(
                    item.connection,
                    item.database,
                    item.table,
                    columnToMove.label,
                    afterColumn
                );
                vscode.window.showInformationMessage(`Column "${columnToMove.label}" reordered successfully!`);
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                vscode.window.showErrorMessage(`Failed to reorder column: ${errorMessage}`);
            }
        } else if (action.value === 'add') {
            // Add column
            const columnName = await vscode.window.showInputBox({
                prompt: 'Enter column name',
                placeHolder: 'column_name'
            });

            if (!columnName) return;

            const columnType = await vscode.window.showQuickPick([
                'bigint', 'bigserial', 'bit', 'boolean', 'char', 'character varying', 
                'date', 'double precision', 'integer', 'json', 'jsonb', 'numeric',
                'real', 'serial', 'smallint', 'smallserial', 'text', 
                'timestamp with time zone', 'timestamp without time zone', 'uuid'
            ], {
                placeHolder: 'Select column type'
            });

            if (!columnType) return;

            const constraints = await vscode.window.showQuickPick(
                [
                    { label: 'NOT NULL', picked: false },
                    { label: 'UNIQUE', picked: false }
                ],
                {
                    canPickMany: true,
                    placeHolder: 'Select constraints (optional)'
                }
            );

            try {
                await databaseExplorer.addColumnToTable(
                    item.connection, 
                    item.database, 
                    item.table, 
                    columnName, 
                    columnType,
                    constraints?.map(c => c.label) || []
                );
                vscode.window.showInformationMessage(`Column "${columnName}" added to table "${item.table}" successfully!`);
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                vscode.window.showErrorMessage(`Failed to add column: ${errorMessage}`);
            }
        } else if (action.value === 'remove') {
            // Remove column - first get list of columns
            try {
                const adapter = DatabaseAdapterFactory.createAdapter(item.connection);
                const columnInfos = await adapter.getColumns(item.database, item.table);
                await adapter.close();

                const columns = columnInfos.map(row => ({
                    label: row.column_name,
                    description: `${row.data_type} ${row.is_nullable === 'NO' ? '(NOT NULL)' : ''}`
                }));

                const columnToRemove = await vscode.window.showQuickPick(columns, {
                    placeHolder: 'Select column to remove'
                });

                if (!columnToRemove) return;

                const answer = await vscode.window.showWarningMessage(
                    `Are you sure you want to remove column "${columnToRemove.label}" from table "${item.table}"? This action cannot be undone!`,
                    'Yes',
                    'No'
                );

                if (answer === 'Yes') {
                    await databaseExplorer.removeColumnFromTable(
                        item.connection,
                        item.database,
                        item.table,
                        columnToRemove.label
                    );
                    vscode.window.showInformationMessage(`Column "${columnToRemove.label}" removed from table "${item.table}" successfully!`);
                }
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                vscode.window.showErrorMessage(`Failed to remove column: ${errorMessage}`);
            }
        }
    });

    let deleteTable = vscode.commands.registerCommand('databaseExplorer.deleteTable', async (item: any) => {
        if (!item?.connection || !item?.database || !item?.table) return;

        const answer = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the table "${item.table}" from database "${item.database}"? This action cannot be undone!`,
            'Yes',
            'No'
        );

        if (answer === 'Yes') {
            try {
                await databaseExplorer.deleteTable(item.connection, item.database, item.table);
                vscode.window.showInformationMessage(`Table "${item.table}" deleted successfully!`);
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                vscode.window.showErrorMessage(`Failed to delete table: ${errorMessage}`);
            }
        }
    });

    let exportDatabase = vscode.commands.registerCommand('databaseExplorer.exportDatabase', async (item: any) => {
        if (!item?.connection || !item?.database) return;

        const includeDataChoice = await vscode.window.showQuickPick(
            [
                { label: 'Structure Only', value: false, description: 'Export only table structures (CREATE TABLE statements)' },
                { label: 'Structure + Data', value: true, description: 'Export table structures and all data (CREATE + INSERT statements)' }
            ],
            {
                placeHolder: `Export database "${item.database}"`
            }
        );

        if (!includeDataChoice) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Exporting database "${item.database}"...`,
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ message: 'Generating SQL export...' });
                const sql = await databaseExplorer.exportDatabase(item.connection, item.database, includeDataChoice.value);
                
                progress.report({ message: 'Saving file...' });
                
                // Create a new untitled document with SQL content
                const doc = await vscode.workspace.openTextDocument({
                    content: sql,
                    language: 'sql'
                });
                
                await vscode.window.showTextDocument(doc);
                
                vscode.window.showInformationMessage(
                    `Database "${item.database}" exported successfully!`
                );
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                vscode.window.showErrorMessage(`Failed to export database: ${errorMessage}`);
            }
        });
    });

    context.subscriptions.push(
        addConnection, 
        refreshConnection, 
        filterDatabases, 
        editConnection, 
        removeConnection,
        openTable,
        addTable,
        refreshDatabase,
        filterTables,
        editTable,
        deleteTable,
        exportDatabase
    );
}