import * as vscode from 'vscode';
import { Client } from 'pg';
import { DatabaseExplorer } from './databaseExplorer';
import { TableViewer } from './tableViewer';
import { Connection } from './types';

export function activate(context: vscode.ExtensionContext) {
    const databaseExplorer = new DatabaseExplorer(context);
    const tableViewer = new TableViewer(context);

    let addConnection = vscode.commands.registerCommand('databaseExplorer.addConnection', async () => {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter connection name',
            placeHolder: 'My Database'
        });

        if (!name) return;

        const dbType = await vscode.window.showQuickPick(
            ['PostgreSQL', 'MySQL', 'MariaDB'],
            {
                placeHolder: 'Select database type',
                canPickMany: false
            }
        );

        if (!dbType) return;

        const host = await vscode.window.showInputBox({
            prompt: 'Enter host',
            placeHolder: 'localhost',
            value: 'localhost'
        });

        const defaultPort = dbType === 'PostgreSQL' ? '5432' : dbType === 'MySQL' || dbType === 'MariaDB' ? '3306' : '0';

        const port = await vscode.window.showInputBox({
            prompt: 'Enter port',
            placeHolder: defaultPort,
            value: defaultPort
        });

        const username = await vscode.window.showInputBox({
            prompt: 'Enter username',
            placeHolder: dbType === 'PostgreSQL' ? 'postgres' : 'root'
        });

        const password = await vscode.window.showInputBox({
            prompt: 'Enter password',
            password: true
        });

        if (!host || !port || !username || !password) {
            vscode.window.showErrorMessage('All fields except database are required!');
            return;
        }

        const connection: Connection = {
            name,
            type: dbType as 'PostgreSQL' | 'MySQL' | 'MariaDB',
            host,
            port: parseInt(port),
            username: username.trim(),
            password
        };

        try {
            const clientConfig = {
                host: host,
                port: parseInt(port),
                user: username.trim(),
                password: password,
                database: 'postgres'
            };

            const client = new Client(clientConfig);
            await client.connect();
            await client.end();

            await databaseExplorer.addConnection(connection);
            vscode.window.showInformationMessage('Connection added successfully!');
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            console.error('Connection error:', errorMessage);
            vscode.window.showErrorMessage(`Failed to connect: ${errorMessage}`);
        }
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
            const clientConfig = {
                host: item.connection.host,
                port: item.connection.port,
                user: item.connection.username,
                password: item.connection.password,
                database: 'postgres'
            };

            const client = new Client(clientConfig);
            await client.connect();

            const res = await client.query(
                "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
            );
            await client.end();

            const databases = res.rows.map(row => row.datname);
            
            const quickPick = vscode.window.createQuickPick();
            quickPick.canSelectMany = true;
            quickPick.title = 'Select Databases to Show';
            quickPick.placeholder = 'Leave empty to show all databases';
            
            quickPick.items = databases.map(db => ({
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

        const dbType = await vscode.window.showQuickPick(
            ['PostgreSQL', 'MySQL', 'MariaDB'],
            {
                placeHolder: 'Select database type',
                canPickMany: false
            }
        );

        if (!dbType) return;

        const host = await vscode.window.showInputBox({
            prompt: 'Enter host',
            value: item.connection.host
        });

        const port = await vscode.window.showInputBox({
            prompt: 'Enter port',
            value: item.connection.port.toString()
        });

        const username = await vscode.window.showInputBox({
            prompt: 'Enter username',
            value: item.connection.username
        });

        const password = await vscode.window.showInputBox({
            prompt: 'Enter password',
            password: true,
            value: item.connection.password
        });

        if (!name || !host || !port || !username || !password) {
            vscode.window.showErrorMessage('All fields except database are required!');
            return;
        }

        const newConnection: Connection = {
            name,
            type: dbType as 'PostgreSQL' | 'MySQL' | 'MariaDB',
            host,
            port: parseInt(port),
            username: username.trim(),
            password
        };

        try {
            const clientConfig = {
                host: host,
                port: parseInt(port),
                user: username.trim(),
                password: password,
                database: 'postgres'
            };

            const client = new Client(clientConfig);
            await client.connect();
            await client.end();

            await databaseExplorer.editConnection(item.connection, newConnection);
            vscode.window.showInformationMessage('Connection updated successfully!');
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to update connection: ${errorMessage}`);
        }
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
            const clientConfig = {
                host: item.connection.host,
                port: item.connection.port,
                user: item.connection.username,
                password: item.connection.password,
                database: item.database
            };

            const client = new Client(clientConfig);
            await client.connect();

            const res = await client.query(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
            );
            await client.end();

            const tables = res.rows.map(row => row.table_name);
            
            const quickPick = vscode.window.createQuickPick();
            quickPick.canSelectMany = true;
            quickPick.title = 'Select Tables to Show';
            quickPick.placeholder = 'Leave empty to show all tables';
            
            quickPick.items = tables.map(table => ({
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

        const action = await vscode.window.showQuickPick([
            { label: 'Rename Table', value: 'rename' },
            { label: 'Add Column', value: 'add' },
            { label: 'Remove Column', value: 'remove' },
            { label: 'Reorder Columns', value: 'reorder' }
        ], {
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
                const clientConfig = {
                    host: item.connection.host,
                    port: item.connection.port,
                    user: item.connection.username,
                    password: item.connection.password,
                    database: item.database
                };

                const client = new Client(clientConfig);
                await client.connect();

                const res = await client.query(
                    `SELECT column_name, data_type, is_nullable 
                    FROM information_schema.columns 
                    WHERE table_name = $1 AND table_schema = 'public' 
                    ORDER BY ordinal_position`,
                    [item.table]
                );
                await client.end();

                if (res.rows.length < 2) {
                    vscode.window.showInformationMessage('Table must have at least 2 columns to reorder.');
                    return;
                }

                const columns = res.rows.map(row => ({
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
                const clientConfig = {
                    host: item.connection.host,
                    port: item.connection.port,
                    user: item.connection.username,
                    password: item.connection.password,
                    database: item.database
                };

                const client = new Client(clientConfig);
                await client.connect();

                const res = await client.query(
                    `SELECT column_name, data_type, is_nullable 
                    FROM information_schema.columns 
                    WHERE table_name = $1 AND table_schema = 'public' 
                    ORDER BY ordinal_position`,
                    [item.table]
                );
                await client.end();

                const columns = res.rows.map(row => ({
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
        deleteTable
    );
}