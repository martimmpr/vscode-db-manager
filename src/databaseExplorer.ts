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

    async createTable(connection: Connection, database: string, tableName: string, columns: Array<{name: string, type: string, constraints: string[]}>) {
        const clientConfig = {
            user: connection.username,
            host: connection.host,
            database: database,
            password: connection.password,
            port: connection.port
        };

        const client = new Client(clientConfig);
        
        try {
            await client.connect();
            
            const columnDefs = columns.map(col => {
                const constraints = col.constraints.join(' ');
                return `"${col.name}" ${col.type} ${constraints}`.trim();
            }).join(', ');
            
            const query = `CREATE TABLE "${tableName}" (${columnDefs})`;
            await client.query(query);
            await client.end();
            
            this._onDidChangeTreeData.fire();
        } catch (error) {
            await client.end();
            throw error;
        }
    }

    async deleteTable(connection: Connection, database: string, tableName: string) {
        const clientConfig = {
            user: connection.username,
            host: connection.host,
            database: database,
            password: connection.password,
            port: connection.port
        };

        const client = new Client(clientConfig);
        
        try {
            await client.connect();
            await client.query(`DROP TABLE "${tableName}"`);
            await client.end();
            
            this._onDidChangeTreeData.fire();
        } catch (error) {
            await client.end();
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
                    return [new DatabaseItem(
                        'No databases found!',
                        vscode.TreeItemCollapsibleState.None,
                        'empty',
                        element.connection
                    )];
                }

                let databases = res.rows.map(row => row.datname);
                
                if (element.connection.selectedDatabases && element.connection.selectedDatabases.length > 0) {
                    databases = databases.filter(db => 
                        element.connection!.selectedDatabases?.includes(db)
                    );
                }

                if (databases.length === 0) {
                    return [new DatabaseItem(
                        'No databases found!',
                        vscode.TreeItemCollapsibleState.None,
                        'empty',
                        element.connection
                    )];
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

                if (res.rows.length === 0) {
                    return [new DatabaseItem(
                        'No tables found!',
                        vscode.TreeItemCollapsibleState.None,
                        'empty',
                        element.connection,
                        element.database
                    )];
                }

                let tables = res.rows.map(row => row.table_name);
                
                if (element.connection.selectedTables && 
                    element.connection.selectedTables[element.database] && 
                    element.connection.selectedTables[element.database].length > 0) {
                    tables = tables.filter(table => 
                        element.connection!.selectedTables![element.database!]?.includes(table)
                    );
                }

                if (tables.length === 0) {
                    return [new DatabaseItem(
                        'No tables found!',
                        vscode.TreeItemCollapsibleState.None,
                        'empty',
                        element.connection,
                        element.database
                    )];
                }
    
                return tables.map(tableName => new DatabaseItem(
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
        const clientConfig = {
            user: connection.username,
            host: connection.host,
            database: database,
            password: connection.password,
            port: connection.port
        };

        const client = new Client(clientConfig);
        
        try {
            await client.connect();
            await client.query(`ALTER TABLE "${oldTableName}" RENAME TO "${newTableName}"`);
            await client.end();
            
            this._onDidChangeTreeData.fire();
        } catch (error) {
            await client.end();
            throw error;
        }
    }

    async reorderColumn(
        connection: Connection,
        database: string,
        tableName: string,
        columnName: string,
        afterColumn?: string
    ) {
        const clientConfig = {
            user: connection.username,
            host: connection.host,
            database: database,
            password: connection.password,
            port: connection.port
        };

        const client = new Client(clientConfig);
        
        try {
            await client.connect();
            
            // PostgreSQL doesn't support direct column reordering
            // We need to recreate the table with the new column order
            
            // Get all columns with their full definition
            const columnsResult = await client.query(`
                SELECT 
                    column_name,
                    data_type,
                    is_nullable,
                    column_default,
                    character_maximum_length,
                    numeric_precision,
                    numeric_scale
                FROM information_schema.columns
                WHERE table_name = $1 AND table_schema = 'public'
                ORDER BY ordinal_position
            `, [tableName]);

            // Get primary key
            const pkResult = await client.query(`
                SELECT a.attname
                FROM pg_index i
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                WHERE i.indrelid = $1::regclass AND i.indisprimary
            `, [tableName]);

            const primaryKeys = pkResult.rows.map(row => row.attname);

            // Get unique constraints
            const uniqueResult = await client.query(`
                SELECT a.attname
                FROM pg_index i
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                WHERE i.indrelid = $1::regclass AND i.indisunique AND NOT i.indisprimary
            `, [tableName]);

            const uniqueKeys = uniqueResult.rows.map(row => row.attname);

            // Reorder columns array
            const columns = columnsResult.rows;
            const columnToMoveIndex = columns.findIndex(c => c.column_name === columnName);
            const columnToMove = columns[columnToMoveIndex];
            
            // Remove from current position
            columns.splice(columnToMoveIndex, 1);
            
            // Insert at new position
            if (afterColumn) {
                const afterIndex = columns.findIndex(c => c.column_name === afterColumn);
                columns.splice(afterIndex + 1, 0, columnToMove);
            } else {
                // Move to first
                columns.unshift(columnToMove);
            }

            // Create column definitions
            const columnDefs = columns.map(col => {
                let def = `"${col.column_name}" ${col.data_type}`;
                
                if (col.character_maximum_length) {
                    def += `(${col.character_maximum_length})`;
                } else if (col.numeric_precision && col.numeric_scale) {
                    def += `(${col.numeric_precision},${col.numeric_scale})`;
                }
                
                if (col.column_default) {
                    def += ` DEFAULT ${col.column_default}`;
                }
                
                if (col.is_nullable === 'NO') {
                    def += ' NOT NULL';
                }
                
                if (primaryKeys.includes(col.column_name)) {
                    def += ' PRIMARY KEY';
                }
                
                if (uniqueKeys.includes(col.column_name)) {
                    def += ' UNIQUE';
                }
                
                return def;
            }).join(', ');

            const tempTableName = `${tableName}_temp_${Date.now()}`;
            const columnNames = columns.map(c => `"${c.column_name}"`).join(', ');

            // Begin transaction
            await client.query('BEGIN');
            
            // Create new table with reordered columns
            await client.query(`CREATE TABLE "${tempTableName}" (${columnDefs})`);
            
            // Copy data
            await client.query(`INSERT INTO "${tempTableName}" (${columnNames}) SELECT ${columnNames} FROM "${tableName}"`);
            
            // Drop old table
            await client.query(`DROP TABLE "${tableName}"`);
            
            // Rename temp table to original name
            await client.query(`ALTER TABLE "${tempTableName}" RENAME TO "${tableName}"`);
            
            // Commit transaction
            await client.query('COMMIT');
            
            await client.end();
            
            this._onDidChangeTreeData.fire();
        } catch (error) {
            await client.query('ROLLBACK');
            await client.end();
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
        const clientConfig = {
            user: connection.username,
            host: connection.host,
            database: database,
            password: connection.password,
            port: connection.port
        };

        const client = new Client(clientConfig);
        
        try {
            await client.connect();
            
            let alterQuery = `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${columnType}`;
            
            // Add constraints
            if (constraints.includes('NOT NULL')) {
                alterQuery += ' NOT NULL';
            }
            
            if (constraints.includes('UNIQUE')) {
                alterQuery += ' UNIQUE';
            }
            
            await client.query(alterQuery);
            await client.end();
            
            this._onDidChangeTreeData.fire();
        } catch (error) {
            await client.end();
            throw error;
        }
    }

    async removeColumnFromTable(
        connection: Connection, 
        database: string, 
        tableName: string, 
        columnName: string
    ) {
        const clientConfig = {
            user: connection.username,
            host: connection.host,
            database: database,
            password: connection.password,
            port: connection.port
        };

        const client = new Client(clientConfig);
        
        try {
            await client.connect();
            
            const alterQuery = `ALTER TABLE "${tableName}" DROP COLUMN "${columnName}"`;
            await client.query(alterQuery);
            await client.end();
            
            this._onDidChangeTreeData.fire();
        } catch (error) {
            await client.end();
            throw error;
        }
    }
}