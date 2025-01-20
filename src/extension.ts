import * as vscode from 'vscode';
import { Client } from 'pg';
import { DatabaseExplorer } from './databaseExplorer';
import { Connection } from './types';

export function activate(context: vscode.ExtensionContext) {
    const databaseExplorer = new DatabaseExplorer(context);

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

        const database = await vscode.window.showInputBox({
            prompt: 'Enter database name (optional)',
            placeHolder: 'Leave empty to show all databases'
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
            password,
            database: database?.trim() || undefined
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
            
            if (database?.trim()) {
                const checkDb = await client.query(
                    "SELECT datname FROM pg_database WHERE datname = $1",
                    [database.trim()]
                );
                
                if (checkDb.rows.length === 0) {
                    await client.end();
                    throw new Error(`Database "${database.trim()}" does not exist`);
                }
            }
            
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

        const database = await vscode.window.showInputBox({
            prompt: 'Enter database name (optional)',
            value: item.connection.database
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
            password,
            database: database?.trim() || undefined
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
            
            if (database?.trim()) {
                const checkDb = await client.query(
                    "SELECT datname FROM pg_database WHERE datname = $1",
                    [database.trim()]
                );
                
                if (checkDb.rows.length === 0) {
                    await client.end();
                    throw new Error(`Database "${database.trim()}" does not exist`);
                }
            }
            
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

    context.subscriptions.push(addConnection, refreshConnection, editConnection, removeConnection);
}