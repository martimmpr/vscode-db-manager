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