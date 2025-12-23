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

        const host = await vscode.window.showInputBox({
            prompt: 'Enter host',
            placeHolder: 'localhost',
            value: 'localhost'
        });

        const port = await vscode.window.showInputBox({
            prompt: 'Enter port',
            placeHolder: '5432',
            value: '5432'
        });

        const username = await vscode.window.showInputBox({
            prompt: 'Enter username',
            placeHolder: 'postgres'
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

    context.subscriptions.push(
        addConnection, 
        refreshConnection, 
        filterDatabases, 
        editConnection, 
        removeConnection,
        openTable
    );
}