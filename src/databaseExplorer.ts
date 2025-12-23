import * as vscode from 'vscode';
import { Client } from 'pg';
import { Connection, DatabaseItem } from './types';

export class DatabaseExplorer implements vscode.TreeDataProvider<DatabaseItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<DatabaseItem | undefined | null | void> = new vscode.EventEmitter<DatabaseItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<DatabaseItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private connections: Connection[] = [];
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        vscode.window.registerTreeDataProvider('databaseExplorer', this);
        this.loadConnections();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    private async loadConnections() {
        this.connections = this.context.globalState.get('connections', []);
        this._onDidChangeTreeData.fire();
    }

    async addConnection(connection: Connection) {
        this.connections.push(connection);
        await this.context.globalState.update('connections', this.connections);
        this._onDidChangeTreeData.fire();
    }

    async refreshConnection(connection: Connection) {
        const item = new DatabaseItem(
            connection.name,
            vscode.TreeItemCollapsibleState.Collapsed,
            'connection',
            connection
        );
        this._onDidChangeTreeData.fire(item);
    }

    async updateDatabaseFilter(connection: Connection, selectedDatabases: string[]) {
        const index = this.connections.findIndex(conn => conn.name === connection.name);
        if (index > -1) {
            this.connections[index] = {
                ...connection,
                selectedDatabases: selectedDatabases.length > 0 ? selectedDatabases : undefined
            };
            await this.context.globalState.update('connections', this.connections);
            this._onDidChangeTreeData.fire();
        }
    }

    async editConnection(oldConnection: Connection, newConnection: Connection) {
        const index = this.connections.findIndex(conn => conn.name === oldConnection.name);
        if (index > -1) {
            this.connections[index] = newConnection;
            await this.context.globalState.update('connections', this.connections);
            this._onDidChangeTreeData.fire();
        }
    }

    async removeConnection(connection: Connection) {
        const index = this.connections.findIndex(conn => conn.name === connection.name);
        if (index > -1) {
            this.connections.splice(index, 1);
            await this.context.globalState.update('connections', this.connections);
            this._onDidChangeTreeData.fire();
        }
    }

    getTreeItem(element: DatabaseItem): vscode.TreeItem {
        const treeItem = element;
        if (element.type === 'connection') {
            treeItem.contextValue = 'databaseConnection';
        } else if (element.type === 'table') {
            treeItem.contextValue = 'table';
            treeItem.command = {
                command: 'databaseExplorer.openTable',
                title: 'Open Table',
                arguments: [element]
            };
        }
        return treeItem;
    }

    async getChildren(element?: DatabaseItem): Promise<DatabaseItem[]> {
        if (!element) {
            return this.connections.map(conn => new DatabaseItem(
                conn.name,
                vscode.TreeItemCollapsibleState.Collapsed,
                'connection',
                conn
            ));
        }

        if (!element.connection) {
            return [];
        }

        if (element.type === 'connection') {
            const clientConfig = {
                user: element.connection.username,
                host: element.connection.host,
                database: 'postgres',
                password: element.connection.password,
                port: element.connection.port
            };

            try {
                const client = new Client(clientConfig);
                await client.connect();

                const res = await client.query(
                    "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
                );
                await client.end();

                if (res.rows.length === 0) {
                    vscode.window.showInformationMessage('No databases found in this connection.');
                    return [];
                }

                let databases = res.rows.map(row => row.datname);
                
                if (element.connection.selectedDatabases && element.connection.selectedDatabases.length > 0) {
                    databases = databases.filter(db => 
                        element.connection!.selectedDatabases?.includes(db)
                    );
                }

                return databases.map(dbName => new DatabaseItem(
                    dbName,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'database',
                    element.connection,
                    dbName
                ));
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                console.error('Database fetch error:', errorMessage);
                vscode.window.showErrorMessage(`Failed to fetch databases: ${errorMessage}`);
                return [];
            }
        }

        if (element.type === 'database' && element.database) {
            const clientConfig = {
                user: element.connection.username,
                host: element.connection.host,
                database: element.database,
                password: element.connection.password,
                port: element.connection.port
            };
    
            const client = new Client(clientConfig);
    
            try {
                await client.connect();
                const res = await client.query(
                    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
                );
                await client.end();
    
                return res.rows.map(row => new DatabaseItem(
                    row.table_name,
                    vscode.TreeItemCollapsibleState.None,
                    'table',
                    element.connection,
                    element.database,
                    row.table_name
                ));
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                console.error('Failed to fetch tables:', errorMessage);
                vscode.window.showErrorMessage(`Failed to fetch tables: ${errorMessage}`);
                return [];
            }
        }

        return [];
    }
}