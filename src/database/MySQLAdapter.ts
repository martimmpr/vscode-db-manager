import * as mysql from 'mysql2/promise';
import { Connection } from '../types';
import { IDatabaseAdapter, ColumnDefinition, ColumnInfo } from './IDatabaseAdapter';

export class MySQLAdapter implements IDatabaseAdapter {
    private connection: Connection;
    private mysqlConnection: mysql.Connection | null = null;
    private currentDatabase: string | null = null;

    constructor(connection: Connection) {
        this.connection = connection;
    }

    private async getConnection(database?: string): Promise<mysql.Connection> {
        const dbToUse = database || this.currentDatabase;
        
        // If we need to switch database or don't have a connection
        if (!this.mysqlConnection || this.currentDatabase !== dbToUse) {
            // Close existing connection if any
            if (this.mysqlConnection) {
                try {
                    await this.mysqlConnection.end();
                } catch (error) {
                    // Ignore errors when closing
                }
            }

            // Create new connection
            this.mysqlConnection = await mysql.createConnection({
                host: this.connection.host,
                port: this.connection.port,
                user: this.connection.username,
                password: this.connection.password,
                database: dbToUse || undefined
            });

            this.currentDatabase = dbToUse;
        }

        return this.mysqlConnection;
    }

    async testConnection(): Promise<void> {
        const conn = await this.getConnection();
        await conn.query('SELECT 1');
    }

    async getDatabases(): Promise<string[]> {
        const conn = await this.getConnection();
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
            "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY schema_name"
        );
        return rows.map(row => row.schema_name);
    }

    async getTables(database: string): Promise<string[]> {
        const conn = await this.getConnection(database);
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
            [database]
        );
        return rows.map(row => row.table_name);
    }

    async createTable(database: string, tableName: string, columns: ColumnDefinition[]): Promise<void> {
        const conn = await this.getConnection(database);
        
        const columnDefs = columns.map(col => {
            let def = `\`${col.name}\` ${col.type}`;
            
            // Handle constraints
            const constraints = col.constraints.filter(c => c !== 'GENERATED ALWAYS AS IDENTITY');
            if (constraints.length > 0) {
                def += ' ' + constraints.join(' ');
            }
            
            // Handle AUTO_INCREMENT (MySQL equivalent of GENERATED ALWAYS AS IDENTITY)
            if (col.constraints.includes('GENERATED ALWAYS AS IDENTITY')) {
                def += ' AUTO_INCREMENT';
            }
            
            return def;
        }).join(', ');
        
        const query = `CREATE TABLE \`${tableName}\` (${columnDefs})`;
        await conn.query(query);
    }

    async deleteTable(database: string, tableName: string): Promise<void> {
        const conn = await this.getConnection(database);
        await conn.query(`DROP TABLE \`${tableName}\``);
    }

    async renameTable(database: string, oldTableName: string, newTableName: string): Promise<void> {
        const conn = await this.getConnection(database);
        await conn.query(`RENAME TABLE \`${oldTableName}\` TO \`${newTableName}\``);
    }

    async addColumn(database: string, tableName: string, columnName: string, columnType: string, constraints: string[]): Promise<void> {
        const conn = await this.getConnection(database);
        
        let alterQuery = `ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnType}`;
        
        if (constraints.includes('NOT NULL')) {
            alterQuery += ' NOT NULL';
        }
        
        if (constraints.includes('UNIQUE')) {
            alterQuery += ' UNIQUE';
        }
        
        await conn.query(alterQuery);
    }

    async removeColumn(database: string, tableName: string, columnName: string): Promise<void> {
        const conn = await this.getConnection(database);
        await conn.query(`ALTER TABLE \`${tableName}\` DROP COLUMN \`${columnName}\``);
    }

    async getColumns(database: string, tableName: string): Promise<ColumnInfo[]> {
        const conn = await this.getConnection(database);
        const [rows] = await conn.query<mysql.RowDataPacket[]>(`
            SELECT 
                column_name,
                data_type,
                is_nullable,
                column_default,
                character_maximum_length,
                numeric_precision,
                numeric_scale
            FROM information_schema.columns
            WHERE table_name = ? AND table_schema = ?
            ORDER BY ordinal_position
        `, [tableName, database]);
        
        return rows as ColumnInfo[];
    }

    async getPrimaryKeys(database: string, tableName: string): Promise<string[]> {
        const conn = await this.getConnection(database);
        const [rows] = await conn.query<mysql.RowDataPacket[]>(`
            SELECT column_name
            FROM information_schema.key_column_usage
            WHERE table_schema = ? 
            AND table_name = ? 
            AND constraint_name = 'PRIMARY'
            ORDER BY ordinal_position
        `, [database, tableName]);
        
        return rows.map(row => row.column_name);
    }

    async getUniqueKeys(database: string, tableName: string): Promise<string[]> {
        const conn = await this.getConnection(database);
        const [rows] = await conn.query<mysql.RowDataPacket[]>(`
            SELECT DISTINCT column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'UNIQUE'
            AND tc.table_schema = ?
            AND tc.table_name = ?
        `, [database, tableName]);
        
        return rows.map(row => row.column_name);
    }

    async query(database: string, query: string, params?: any[]): Promise<any> {
        const conn = await this.getConnection(database);
        const [rows] = await conn.query(query, params);
        return rows;
    }

    async close(): Promise<void> {
        if (this.mysqlConnection) {
            try {
                await this.mysqlConnection.end();
                this.mysqlConnection = null;
                this.currentDatabase = null;
            } catch (error) {
                // Ignore errors when closing
                this.mysqlConnection = null;
                this.currentDatabase = null;
            }
        }
    }
}