import * as mysql from 'mysql2/promise';
import { Connection } from '../types';
import { IDatabaseAdapter, ColumnDefinition, ColumnInfo, QueryResult } from './IDatabaseAdapter';

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
        console.log('MySQL getDatabases result:', rows);
        const databases = rows.map(row => row.SCHEMA_NAME || row.schema_name);
        console.log('MySQL databases mapped:', databases);
        return databases;
    }

    async getTables(database: string): Promise<string[]> {
        const conn = await this.getConnection(database);
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
            [database]
        );
        return rows.map(row => row.TABLE_NAME || row.table_name);
    }

    async createTable(database: string, tableName: string, columns: ColumnDefinition[]): Promise<void> {
        const conn = await this.getConnection(database);
        
        const primaryKeys: string[] = [];
        const uniqueKeys: string[] = [];
        
        const columnDefs = columns.map(col => {
            let def = `\`${col.name}\` ${col.type}`;
            
            // Separate PRIMARY KEY and UNIQUE to add as constraints later
            const constraints = col.constraints.filter(c => {
                if (c === 'GENERATED ALWAYS AS IDENTITY') return false;
                
                if (c === 'PRIMARY KEY') {
                    primaryKeys.push(col.name);
                    return false;
                }
                if (c === 'UNIQUE') {
                    uniqueKeys.push(col.name);
                    return false;
                }
                
                return true;
            });
            
            if (constraints.length > 0) {
                def += ' ' + constraints.join(' ');
            }
            
            // Handle AUTO_INCREMENT (MySQL equivalent of GENERATED ALWAYS AS IDENTITY)
            if (col.constraints.includes('GENERATED ALWAYS AS IDENTITY')) {
                def += ' AUTO_INCREMENT';
            }
            
            return def;
        }).join(', ');
        
        // Add PRIMARY KEY constraint with prefix length for TEXT/BLOB columns
        let constraints = '';
        if (primaryKeys.length > 0) {
            const pkDefs = primaryKeys.map(pk => {
                const col = columns.find(c => c.name === pk);
                const isTextType = col && (col.type.toUpperCase().includes('TEXT') || col.type.toUpperCase().includes('BLOB'));
                return isTextType ? `\`${pk}\`(255)` : `\`${pk}\``;
            }).join(', ');
            constraints += `, PRIMARY KEY (${pkDefs})`;
        }
        
        // Add UNIQUE constraint with prefix length for TEXT/BLOB columns
        uniqueKeys.forEach(uk => {
            const col = columns.find(c => c.name === uk);
            const isTextType = col && (col.type.toUpperCase().includes('TEXT') || col.type.toUpperCase().includes('BLOB'));
            const ukDef = isTextType ? `\`${uk}\`(255)` : `\`${uk}\``;
            constraints += `, UNIQUE (${ukDef})`;
        });
        
        const query = `CREATE TABLE IF NOT EXISTS \`${tableName}\` (${columnDefs}${constraints})`;
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
        
        // Check if column exists
        const [colRows] = await conn.query(
            `SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
            [database, tableName, columnName]
        );
        if (Array.isArray(colRows) && colRows.length === 0) {
            let alterQuery = `ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnType}`;
            if (constraints.includes('NOT NULL')) {
                alterQuery += ' NOT NULL';
            }
            if (constraints.includes('UNIQUE')) {
                alterQuery += ' UNIQUE';
            }
            await conn.query(alterQuery);
        }
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
        
        // Map MySQL uppercase column names to lowercase
        return rows.map(row => ({
            column_name: row.COLUMN_NAME || row.column_name,
            data_type: row.DATA_TYPE || row.data_type,
            is_nullable: row.IS_NULLABLE || row.is_nullable,
            column_default: row.COLUMN_DEFAULT || row.column_default,
            character_maximum_length: row.CHARACTER_MAXIMUM_LENGTH || row.character_maximum_length,
            numeric_precision: row.NUMERIC_PRECISION || row.numeric_precision,
            numeric_scale: row.NUMERIC_SCALE || row.numeric_scale
        })) as ColumnInfo[];
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
        
        return rows.map(row => row.COLUMN_NAME || row.column_name);
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
        
        return rows.map(row => row.COLUMN_NAME || row.column_name);
    }

    async query(database: string, query: string, params?: any[]): Promise<any> {
        const conn = await this.getConnection(database);
        const [rows] = await conn.query(query, params);
        return rows;
    }

    async exportDatabase(database: string, includeData: boolean): Promise<string> {
        const conn = await this.getConnection(database);
        let sql = `-- MySQL Database Export: ${database}\n`;
        sql += `-- Generated on: ${new Date().toISOString()}\n\n`;
        sql += `USE \`${database}\`;\n\n`;

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
        const conn = await this.getConnection(database);
        let sql = `-- Table: ${tableName}\n`;

        // Get table structure
        const columns = await this.getColumns(database, tableName);
        const primaryKeys = await this.getPrimaryKeys(database, tableName);

        // Create table statement
        sql += `DROP TABLE IF EXISTS \`${tableName}\`;\n`;
        sql += `CREATE TABLE \`${tableName}\` (\n`;

        const columnDefs = columns.map((col: ColumnInfo) => {
            let def = `  \`${col.column_name}\` ${col.data_type}`;
            
            if (col.character_maximum_length) {
                def += `(${col.character_maximum_length})`;
            } else if (col.numeric_precision && col.numeric_scale !== null) {
                def += `(${col.numeric_precision}, ${col.numeric_scale})`;
            }

            if (col.is_nullable === 'NO') {
                def += ' NOT NULL';
            }

            if (col.column_default !== null) {
                def += ` DEFAULT ${col.column_default}`;
            }

            return def;
        });

        sql += columnDefs.join(',\n');

        // Add primary key constraint
        if (primaryKeys.length > 0) {
            const pkColumns = primaryKeys.map(pk => `\`${pk}\``).join(', ');
            sql += `,\n  PRIMARY KEY (${pkColumns})`;
        }

        sql += '\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n';

        // Export data if requested
        if (includeData) {
            const [rows] = await conn.query<mysql.RowDataPacket[]>(`SELECT * FROM \`${tableName}\``);
            
            if (rows.length > 0) {
                sql += `\n-- Data for table: ${tableName}\n`;
                
                for (const row of rows) {
                    const columnNames = Object.keys(row).map(col => `\`${col}\``).join(', ');
                    const values = Object.values(row).map(val => {
                        if (val === null) return 'NULL';
                        if (typeof val === 'number') return val;
                        if (typeof val === 'boolean') return val ? '1' : '0';
                        if (val instanceof Date) return `'${val.toISOString().slice(0, 19).replace('T', ' ')}'`;
                        if (val instanceof Buffer) return `0x${val.toString('hex')}`;
                        if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "\\'")}'`;
                        return `'${String(val).replace(/'/g, "\\'")}'`;
                    }).join(', ');
                    
                    sql += `INSERT INTO \`${tableName}\` (${columnNames}) VALUES (${values});\n`;
                }
            }
        }

        return sql;
    }

    async executeQuery(query: string, database?: string): Promise<QueryResult> {
        const conn = await this.getConnection(database);
        const [rows, fields] = await conn.query(query);
        
        // Check if it's a result set or an OkPacket
        if (Array.isArray(rows)) {
            return {
                rows: rows as any[],
                fields: (fields as mysql.FieldPacket[])?.map(field => {
                    const flags = field.flags as any as number || 0;
                    return {
                        name: field.name,
                        dataType: field.type !== undefined ? this.getMySQLType(field.type) : undefined,
                        isPrimaryKey: (flags & 2) !== 0, // PRI_KEY_FLAG
                        isUnique: (flags & 4) !== 0, // UNIQUE_KEY_FLAG
                        isAutoIncrement: (flags & 512) !== 0, // AUTO_INCREMENT_FLAG
                        isNullable: (flags & 1) === 0 // NOT_NULL_FLAG
                    };
                }),
                affectedRows: undefined
            };
        } else {
            // OkPacket for INSERT, UPDATE, DELETE
            const okPacket = rows as mysql.OkPacket;
            return {
                rows: [],
                fields: undefined,
                affectedRows: okPacket.affectedRows
            };
        }
    }

    private getMySQLType(type: number): string {
        const types: { [key: number]: string } = {
            0: 'decimal',
            1: 'tinyint',
            2: 'smallint',
            3: 'int',
            4: 'float',
            5: 'double',
            7: 'timestamp',
            8: 'bigint',
            9: 'mediumint',
            10: 'date',
            11: 'time',
            12: 'datetime',
            13: 'year',
            15: 'varchar',
            16: 'bit',
            245: 'json',
            246: 'decimal',
            247: 'enum',
            248: 'set',
            249: 'tinyblob',
            250: 'mediumblob',
            251: 'longblob',
            252: 'blob',
            253: 'varchar',
            254: 'char',
        };
        return types[type] || `type(${type})`;
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