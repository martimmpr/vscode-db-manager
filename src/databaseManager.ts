import * as vscode from 'vscode';
import { Connection, DatabaseItem } from './types';
import { DatabaseAdapterFactory, ColumnDefinition } from './database';

export class DatabaseManager implements vscode.TreeDataProvider<DatabaseItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<DatabaseItem | undefined | null | void> = new vscode.EventEmitter<DatabaseItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<DatabaseItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private connections: Connection[] = [];
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        vscode.window.registerTreeDataProvider('databaseManager', this);
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

    async refreshDatabase(connection: Connection, database: string) {
        this._onDidChangeTreeData.fire();
    }

    async updateTableFilter(connection: Connection, database: string, selectedTables: string[]) {
        const index = this.connections.findIndex(conn => conn.name === connection.name);
        if (index > -1) {
            const updatedConnection = {
                ...connection,
                selectedTables: {
                    ...connection.selectedTables,
                    [database]: selectedTables.length > 0 ? selectedTables : []
                }
            };
            this.connections[index] = updatedConnection;
            await this.context.globalState.update('connections', this.connections);
            this._onDidChangeTreeData.fire();
        }
    }

    async createTable(connection: Connection, database: string, tableName: string, columns: ColumnDefinition[]) {
        const adapter = DatabaseAdapterFactory.createAdapter(connection);
        
        try {
            await adapter.createTable(database, tableName, columns);
            await adapter.close();
            
            this._onDidChangeTreeData.fire();
        } catch (error) {
            await adapter.close();
            throw error;
        }
    }

    async deleteTable(connection: Connection, database: string, tableName: string) {
        const adapter = DatabaseAdapterFactory.createAdapter(connection);
        
        try {
            await adapter.deleteTable(database, tableName);
            await adapter.close();
            
            this._onDidChangeTreeData.fire();
        } catch (error) {
            await adapter.close();
            throw error;
        }
    }

    getTreeItem(element: DatabaseItem): vscode.TreeItem {
        const treeItem = element;
        if (element.type === 'connection') {
            treeItem.contextValue = 'databaseConnection';
        } else if (element.type === 'database') {
            treeItem.contextValue = 'database';
        } else if (element.type === 'table') {
            treeItem.contextValue = 'table';
            treeItem.command = {
                command: 'databaseManager.openTable',
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
                conn,
                undefined,
                undefined,
                this.context.extensionPath
            ));
        }

        if (!element.connection) {
            return [];
        }

        if (element.type === 'connection') {
            try {
                const adapter = DatabaseAdapterFactory.createAdapter(element.connection);
                const databases = await adapter.getDatabases();
                await adapter.close();

                if (databases.length === 0) {
                    return [new DatabaseItem(
                        'No databases found!',
                        vscode.TreeItemCollapsibleState.None,
                        'empty',
                        element.connection
                    )];
                }

                let filteredDatabases = databases;
                
                if (element.connection.selectedDatabases && element.connection.selectedDatabases.length > 0) {
                    filteredDatabases = databases.filter((db: string) => 
                        element.connection!.selectedDatabases?.includes(db)
                    );
                }

                if (filteredDatabases.length === 0) {
                    return [new DatabaseItem(
                        'No databases found!',
                        vscode.TreeItemCollapsibleState.None,
                        'empty',
                        element.connection
                    )];
                }

                return filteredDatabases.map((dbName: string) => new DatabaseItem(
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
            try {
                const adapter = DatabaseAdapterFactory.createAdapter(element.connection);
                const tables = await adapter.getTables(element.database);
                await adapter.close();

                if (tables.length === 0) {
                    return [new DatabaseItem(
                        'No tables found!',
                        vscode.TreeItemCollapsibleState.None,
                        'empty',
                        element.connection,
                        element.database
                    )];
                }

                let filteredTables = tables;
                
                if (element.connection.selectedTables && 
                    element.connection.selectedTables[element.database] && 
                    element.connection.selectedTables[element.database].length > 0) {
                    filteredTables = tables.filter((table: string) => 
                        element.connection!.selectedTables![element.database!]?.includes(table)
                    );
                }

                if (filteredTables.length === 0) {
                    return [new DatabaseItem(
                        'No tables found!',
                        vscode.TreeItemCollapsibleState.None,
                        'empty',
                        element.connection,
                        element.database
                    )];
                }
    
                return filteredTables.map((tableName: string) => new DatabaseItem(
                    tableName,
                    vscode.TreeItemCollapsibleState.None,
                    'table',
                    element.connection,
                    element.database,
                    tableName
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

    async renameTable(
        connection: Connection,
        database: string,
        oldTableName: string,
        newTableName: string
    ) {
        const adapter = DatabaseAdapterFactory.createAdapter(connection);
        
        try {
            await adapter.renameTable(database, oldTableName, newTableName);
            await adapter.close();
            
            this._onDidChangeTreeData.fire();
        } catch (error) {
            await adapter.close();
            throw error;
        }
    }

    async addColumnToTable(
        connection: Connection, 
        database: string, 
        tableName: string, 
        columnName: string, 
        columnType: string,
        constraints: string[]
    ) {
        const adapter = DatabaseAdapterFactory.createAdapter(connection);
        
        try {
            await adapter.addColumn(database, tableName, columnName, columnType, constraints);
            await adapter.close();
            
            this._onDidChangeTreeData.fire();
        } catch (error) {
            await adapter.close();
            throw error;
        }
    }

    async removeColumnFromTable(
        connection: Connection, 
        database: string, 
        tableName: string, 
        columnName: string
    ) {
        const adapter = DatabaseAdapterFactory.createAdapter(connection);
        
        try {
            await adapter.removeColumn(database, tableName, columnName);
            await adapter.close();
            
            this._onDidChangeTreeData.fire();
        } catch (error) {
            await adapter.close();
            throw error;
        }
    }

    async exportDatabase(connection: Connection, database: string, includeData: boolean): Promise<string> {
        const adapter = DatabaseAdapterFactory.createAdapter(connection);
        
        try {
            const sql = await adapter.exportDatabase(database, includeData);
            await adapter.close();
            return sql;
        } catch (error) {
            await adapter.close();
            throw error;
        }
    }
}