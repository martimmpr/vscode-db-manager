import { Client } from 'pg';
import { Connection } from '../types';
import { IDatabaseAdapter, ColumnDefinition, ColumnInfo } from './IDatabaseAdapter';

export class PostgreSQLAdapter implements IDatabaseAdapter {
    private connection: Connection;
    private client: Client | null = null;
    private currentDatabase: string = 'postgres';

    constructor(connection: Connection) {
        this.connection = connection;
    }

    private async getClient(database?: string): Promise<Client> {
        const dbToUse = database || this.currentDatabase;
        
        // If we already have a client connected to the same database, reuse it
        if (this.client && this.currentDatabase === dbToUse) {
            return this.client;
        }

        // Close existing client if any
        if (this.client) {
            try {
                await this.client.end();
            } catch (error) {
                // Ignore errors when closing
            }
        }

        // Create new client
        this.client = new Client({
            host: this.connection.host,
            port: this.connection.port,
            user: this.connection.username,
            password: this.connection.password,
            database: dbToUse
        });

        await this.client.connect();
        this.currentDatabase = dbToUse;
        return this.client;
    }

    async testConnection(): Promise<void> {
        const client = await this.getClient('postgres');
        await client.query('SELECT 1');
    }

    async getDatabases(): Promise<string[]> {
        const client = await this.getClient('postgres');
        const result = await client.query(
            "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
        );
        return result.rows.map(row => row.datname);
    }

    async getTables(database: string): Promise<string[]> {
        const client = await this.getClient(database);
        const result = await client.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
        );
        return result.rows.map(row => row.table_name);
    }

    async createTable(database: string, tableName: string, columns: ColumnDefinition[]): Promise<void> {
        const client = await this.getClient(database);
        
        const columnDefs = columns.map(col => {
            const constraints = col.constraints.join(' ');
            return `"${col.name}" ${col.type} ${constraints}`.trim();
        }).join(', ');
        
        const query = `CREATE TABLE "${tableName}" (${columnDefs})`;
        await client.query(query);
    }

    async deleteTable(database: string, tableName: string): Promise<void> {
        const client = await this.getClient(database);
        await client.query(`DROP TABLE "${tableName}"`);
    }

    async renameTable(database: string, oldTableName: string, newTableName: string): Promise<void> {
        const client = await this.getClient(database);
        await client.query(`ALTER TABLE "${oldTableName}" RENAME TO "${newTableName}"`);
    }

    async addColumn(database: string, tableName: string, columnName: string, columnType: string, constraints: string[]): Promise<void> {
        const client = await this.getClient(database);
        
        let alterQuery = `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${columnType}`;
        
        if (constraints.includes('NOT NULL')) {
            alterQuery += ' NOT NULL';
        }
        
        if (constraints.includes('UNIQUE')) {
            alterQuery += ' UNIQUE';
        }
        
        await client.query(alterQuery);
    }

    async removeColumn(database: string, tableName: string, columnName: string): Promise<void> {
        const client = await this.getClient(database);
        await client.query(`ALTER TABLE "${tableName}" DROP COLUMN "${columnName}"`);
    }

    async getColumns(database: string, tableName: string): Promise<ColumnInfo[]> {
        const client = await this.getClient(database);
        const result = await client.query(`
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
        
        return result.rows;
    }

    async getPrimaryKeys(database: string, tableName: string): Promise<string[]> {
        const client = await this.getClient(database);
        const result = await client.query(`
            SELECT a.attname
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = $1::regclass AND i.indisprimary
        `, [tableName]);
        
        return result.rows.map(row => row.attname);
    }

    async getUniqueKeys(database: string, tableName: string): Promise<string[]> {
        const client = await this.getClient(database);
        const result = await client.query(`
            SELECT a.attname
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = $1::regclass AND i.indisunique AND NOT i.indisprimary
        `, [tableName]);
        
        return result.rows.map(row => row.attname);
    }

    async query(database: string, query: string, params?: any[]): Promise<any> {
        const client = await this.getClient(database);
        const result = await client.query(query, params);
        return result;
    }

    async exportDatabase(database: string, includeData: boolean): Promise<string> {
        const client = await this.getClient(database);
        let sql = `-- PostgreSQL Database Export: ${database}\n`;
        sql += `-- Generated on: ${new Date().toISOString()}\n\n`;
        sql += `\\c ${database};\n\n`;

        // Get all tables
        const tables = await this.getTables(database);

        if (tables.length === 0) {
            sql += '-- No tables found in this database\n';
            return sql;
        }

        for (let i = 0; i < tables.length; i++) {
            sql += await this.exportTable(database, tables[i], includeData);
            if (i < tables.length - 1) {
                sql += '\n\n';
            }
        }

        return sql;
    }

    async exportTable(database: string, tableName: string, includeData: boolean): Promise<string> {
        const client = await this.getClient(database);
        let sql = `-- Table: ${tableName}\n`;

        // Get table structure
        const columns = await this.getColumns(database, tableName);
        const primaryKeys = await this.getPrimaryKeys(database, tableName);

        // Create table statement
        sql += `DROP TABLE IF EXISTS "${tableName}" CASCADE;\n`;
        sql += `CREATE TABLE "${tableName}" (\n`;

        const columnDefs = columns.map((col: ColumnInfo) => {
            let def = `  "${col.column_name}" ${col.data_type}`;
            
            if (col.character_maximum_length) {
                def += `(${col.character_maximum_length})`;
            } else if (col.numeric_precision && col.numeric_scale !== null) {
                def += `(${col.numeric_precision}, ${col.numeric_scale})`;
            }

            if (col.is_nullable === 'NO') {
                def += ' NOT NULL';
            }

            if (col.column_default) {
                def += ` DEFAULT ${col.column_default}`;
            }

            return def;
        });

        sql += columnDefs.join(',\n');

        // Add primary key constraint
        if (primaryKeys.length > 0) {
            const pkColumns = primaryKeys.map(pk => `"${pk}"`).join(', ');
            sql += `,\n  PRIMARY KEY (${pkColumns})`;
        }

        sql += '\n);\n';

        // Export data if requested
        if (includeData) {
            const result = await client.query(`SELECT * FROM "${tableName}"`);
            
            if (result.rows.length > 0) {
                sql += `\n-- Data for table: ${tableName}\n`;
                
                for (const row of result.rows) {
                    const columnNames = Object.keys(row).map(col => `"${col}"`).join(', ');
                    const values = Object.values(row).map(val => {
                        if (val === null) return 'NULL';
                        if (typeof val === 'number') return val;
                        if (typeof val === 'boolean') return val;
                        if (val instanceof Date) return `'${val.toISOString()}'`;
                        if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
                        return `'${String(val).replace(/'/g, "''")}'`;
                    }).join(', ');
                    
                    sql += `INSERT INTO "${tableName}" (${columnNames}) VALUES (${values});\n`;
                }
            }
        }

        return sql;
    }

    async close(): Promise<void> {
        if (this.client) {
            try {
                await this.client.end();
                this.client = null;
            } catch (error) {
                // Ignore errors when closing
                this.client = null;
            }
        }
    }
}