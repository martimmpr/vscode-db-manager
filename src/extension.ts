import * as vscode from 'vscode';
import { DatabaseManager } from './databaseManager';
import { TableViewer } from './tableViewer';
import { SqlQueryRunner } from './sqlQueryRunner';
import { ConnectionEditor } from './connectionEditor';
import { TableEditor } from './tableEditor';
import { Connection } from './types';
import { DatabaseAdapterFactory, DatabaseDetector } from './database';

export function activate(context: vscode.ExtensionContext) {
    const databaseManager = new DatabaseManager(context);
    const tableViewer = new TableViewer(context);
    const sqlQueryRunner = new SqlQueryRunner(context);
    const connectionEditor = new ConnectionEditor(context);
    const tableEditor = new TableEditor(context);

    let addConnection = vscode.commands.registerCommand('databaseManager.addConnection', async () => {
        const connection = await connectionEditor.openEditor();
        
        if (connection) {
            await databaseManager.addConnection(connection);
            vscode.window.showInformationMessage(
                `${connection.type} connection "${connection.name}" added successfully!`
            );
        }
    });

    let refreshConnection = vscode.commands.registerCommand('databaseManager.refreshConnection', async (item: any) => {
        if (!item?.connection) return;
        
        try {
            databaseManager.refreshConnection(item.connection);
            vscode.window.showInformationMessage(`Connection "${item.connection.name}" refreshed successfully!`);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to refresh connection: ${errorMessage}`);
        }
    });

    let filterDatabases = vscode.commands.registerCommand('databaseManager.filterDatabases', async (item: any) => {
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
                await databaseManager.updateDatabaseFilter(item.connection, selectedDatabases);
                quickPick.dispose();
            });

            quickPick.show();
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to fetch databases: ${errorMessage}`);
        }
    });

    let editConnection = vscode.commands.registerCommand('databaseManager.editConnection', async (item: any) => {
        if (!item?.connection) return;

        const updatedConnection = await connectionEditor.openEditor(item.connection);
        
        if (updatedConnection) {
            await databaseManager.editConnection(item.connection, updatedConnection);
            vscode.window.showInformationMessage(
                `${updatedConnection.type} connection "${updatedConnection.name}" updated successfully!`
            );
        }
    });

    let removeConnection = vscode.commands.registerCommand('databaseManager.removeConnection', async (item: any) => {
        if (!item?.connection) return;

        const answer = await vscode.window.showWarningMessage(
            `Are you sure you want to remove the connection "${item.connection.name}"?`,
            'Yes',
            'No'
        );

        if (answer === 'Yes') {
            await databaseManager.removeConnection(item.connection);
            vscode.window.showInformationMessage('Connection removed successfully!');
        }
    });

    let openTable = vscode.commands.registerCommand('databaseManager.openTable', async (item: any) => {
        if (!item?.connection || !item?.database || !item?.table) {
            vscode.window.showErrorMessage('Invalid table item');
            return;
        }

        await tableViewer.openTable(item.connection, item.database, item.table);
    });

    let addTable = vscode.commands.registerCommand('databaseManager.addTable', async (item: any) => {
        if (!item?.connection || !item?.database) return;

        const result = await tableEditor.openEditor({
            mode: 'create',
            connection: item.connection,
            database: item.database
        });

        if (result) {
            await databaseManager.createTable(item.connection, item.database, result.tableName, result.columns);
            vscode.window.showInformationMessage(`Table "${result.tableName}" created successfully!`);
        }
    });

    let refreshDatabase = vscode.commands.registerCommand('databaseManager.refreshDatabase', async (item: any) => {
        if (!item?.connection || !item?.database) return;
        
        try {
            await databaseManager.refreshDatabase(item.connection, item.database);
            vscode.window.showInformationMessage(`Database "${item.database}" refreshed successfully!`);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to refresh database: ${errorMessage}`);
        }
    });

    let filterTables = vscode.commands.registerCommand('databaseManager.filterTables', async (item: any) => {
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
                await databaseManager.updateTableFilter(item.connection, item.database, selectedTables);
                quickPick.dispose();
            });

            quickPick.show();
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to fetch tables: ${errorMessage}`);
        }
    });

    let editTable = vscode.commands.registerCommand('databaseManager.editTable', async (item: any) => {
        if (!item?.connection || !item?.database || !item?.table) return;

        // Build options based on database type
        const options = [
            { label: 'Rename Table', value: 'rename' },
            { label: 'Add Column', value: 'add' },
            { label: 'Edit Column', value: 'edit' },
            { label: 'Remove Column', value: 'remove' }
        ];

        const action = await vscode.window.showQuickPick(options, {
            placeHolder: `Edit table "${item.table}"`
        });

        if (!action) return;

        if (action.value === 'rename') {
            const result = await tableEditor.openEditor({
                mode: 'rename',
                connection: item.connection,
                database: item.database,
                tableName: item.table
            });

            if (result) {
                // Update the webview if the table is currently open
                const isOpen = tableViewer.isTableOpen(item.connection, item.database, item.table);
                if (isOpen) {
                    await tableViewer.updateTableNameBeforeRename(result.newTableName);
                    await tableViewer.reloadCurrentTable();
                }
                
                // Refresh the treeview to show the new table name
                databaseManager.refresh();
                
                vscode.window.showInformationMessage(`Table renamed from "${item.table}" to "${result.newTableName}" successfully!`);
            }
        } else if (action.value === 'add') {
            const result = await tableEditor.openEditor({
                mode: 'addColumn',
                connection: item.connection,
                database: item.database,
                tableName: item.table
            });

            if (result) {
                // Column added by tableEditor, just refresh the views
                databaseManager.refresh();
                
                if (tableViewer.isTableOpen(item.connection, item.database, item.table)) {
                    await tableViewer.reloadCurrentTable();
                }
                
                vscode.window.showInformationMessage(`Column "${result.columnName}" added to table "${item.table}" successfully!`);
            }
        } else if (action.value === 'edit') {
            // Edit column - first get list of columns
            try {
                const adapter = DatabaseAdapterFactory.createAdapter(item.connection);
                const columnInfos = await adapter.getColumns(item.database, item.table);
                const uniqueKeys = await adapter.getUniqueKeys(item.database, item.table);
                const primaryKeys = await adapter.getPrimaryKeys(item.database, item.table);
                await adapter.close();

                const columns = columnInfos.map(row => ({
                    label: row.column_name,
                    description: `${row.data_type} ${row.is_nullable === 'NO' ? '(NOT NULL)' : ''}`
                }));

                const columnToEdit = await vscode.window.showQuickPick(columns, {
                    placeHolder: 'Select column to edit'
                });

                if (!columnToEdit) return;

                const result = await tableEditor.openEditor({
                    mode: 'editColumn',
                    connection: item.connection,
                    database: item.database,
                    tableName: item.table,
                    columnName: columnToEdit.label,
                    existingColumns: columnInfos,
                    uniqueKeys: uniqueKeys,
                    primaryKeys: primaryKeys
                });

                if (result) {
                    if (tableViewer.isTableOpen(item.connection, item.database, item.table)) {
                        await tableViewer.reloadCurrentTable();
                    }
                    
                    vscode.window.showInformationMessage(`Column "${result.columnName}" updated in table "${item.table}" successfully!`);
                }
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                vscode.window.showErrorMessage(`Failed to edit column: ${errorMessage}`);
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
                    await databaseManager.removeColumnFromTable(
                        item.connection,
                        item.database,
                        item.table,
                        columnToRemove.label
                    );
                    
                    if (tableViewer.isTableOpen(item.connection, item.database, item.table)) {
                        await tableViewer.reloadCurrentTable();
                    }
                    
                    vscode.window.showInformationMessage(`Column "${columnToRemove.label}" removed from table "${item.table}" successfully!`);
                }
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                vscode.window.showErrorMessage(`Failed to remove column: ${errorMessage}`);
            }
        }
    });

    let deleteTable = vscode.commands.registerCommand('databaseManager.deleteTable', async (item: any) => {
        if (!item?.connection || !item?.database || !item?.table) return;

        const answer = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the table "${item.table}" from database "${item.database}"? This action cannot be undone!`,
            'Yes',
            'No'
        );

        if (answer === 'Yes') {
            try {
                await databaseManager.deleteTable(item.connection, item.database, item.table);
                vscode.window.showInformationMessage(`Table "${item.table}" deleted successfully!`);
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                vscode.window.showErrorMessage(`Failed to delete table: ${errorMessage}`);
            }
        }
    });

    let exportDatabase = vscode.commands.registerCommand('databaseManager.exportDatabase', async (item: any) => {
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
                const sql = await databaseManager.exportDatabase(item.connection, item.database, includeDataChoice.value);
                
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

    let openTerminal = vscode.commands.registerCommand('databaseManager.openTerminal', async (item: any) => {
        if (!item?.connection || !item?.database) return;

        try {
            const connection = item.connection;
            const database = item.database;
            const dbType = connection.type.toLowerCase();
            
            // Build terminal configuration based on database type
            let terminal: vscode.Terminal;
            let command: string;
            
            switch (dbType) {
                case 'postgresql':
                    // Create terminal with PGPASSWORD environment variable
                    terminal = vscode.window.createTerminal({
                        name: `${connection.name} - ${database}`,
                        env: {
                            'PGPASSWORD': connection.password
                        }
                    });
                    command = `psql -U ${connection.username} -h ${connection.host} -p ${connection.port} -d ${database}`;
                    break;
                
                case 'mysql':
                case 'mariadb':
                    // Create terminal with MYSQL_PWD environment variable
                    terminal = vscode.window.createTerminal({
                        name: `${connection.name} - ${database}`,
                        env: {
                            'MYSQL_PWD': connection.password
                        }
                    });
                    command = `mysql -u ${connection.username} -h ${connection.host} -P ${connection.port} ${database}`;
                    break;
                
                default:
                    vscode.window.showErrorMessage(`Unsupported database type: ${connection.type}`);
                    return;
            }

            // Show the terminal and send the command
            terminal.show();
            terminal.sendText(`clear && ${command}`);

        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to open terminal: ${errorMessage}`);
        }
    });

    // SQL Query Runner commands
    let selectConnection = vscode.commands.registerCommand('sqlQueryRunner.selectConnection', async () => {
        await sqlQueryRunner.selectConnection();
    });

    let selectDatabase = vscode.commands.registerCommand('sqlQueryRunner.selectDatabase', async () => {
        await sqlQueryRunner.selectDatabase();
    });

    let executeQuery = vscode.commands.registerCommand('sqlQueryRunner.executeQuery', async () => {
        await sqlQueryRunner.executeQuery();
    });

    let executeCurrentLine = vscode.commands.registerCommand('sqlQueryRunner.executeCurrentLine', async () => {
        await sqlQueryRunner.executeCurrentLine();
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
        exportDatabase,
        openTerminal,
        selectConnection,
        selectDatabase,
        executeQuery,
        executeCurrentLine
    );
}