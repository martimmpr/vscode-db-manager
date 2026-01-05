import { Client } from 'pg';
import { Connection } from '../types';
import { IDatabaseAdapter, ColumnDefinition, ColumnInfo, QueryResult } from './IDatabaseAdapter';

export class PostgreSQLAdapter implements IDatabaseAdapter {
    private connection: Connection;
    private client: Client | null = null;
    private currentDatabase: string;

    constructor(connection: Connection) {
        this.connection = connection;
        this.currentDatabase = connection.database || 'postgres';
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
        const client = await this.getClient(this.connection.database || 'postgres');
        await client.query('SELECT 1');
    }

    async getDatabases(): Promise<string[]> {
        const client = await this.getClient(this.connection.database || 'postgres');
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
        
        const query = `CREATE TABLE IF NOT EXISTS "${tableName}" (${columnDefs})`;
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

    async addColumn(database: string, tableName: string, columnName: string, columnType: string, constraints: string[], defaultValue?: string): Promise<void> {
        const client = await this.getClient(database);
        
        let alterQuery = `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${columnType}`;
        
        // Add DEFAULT before constraints
        if (defaultValue !== undefined && defaultValue !== '') {
            // Handle special keywords and string values
            if (['CURRENT_TIMESTAMP', 'NULL', 'TRUE', 'FALSE', 'NOW()'].includes(defaultValue.toUpperCase())) {
                alterQuery += ` DEFAULT ${defaultValue.toUpperCase()}`;
            } else if (!isNaN(Number(defaultValue))) {
                // Numeric value
                alterQuery += ` DEFAULT ${defaultValue}`;
            } else {
                // String value - escape single quotes
                alterQuery += ` DEFAULT '${defaultValue.replace(/'/g, "''")}'`;
            }
        }
        
        if (constraints.includes('NOT NULL')) {
            alterQuery += ' NOT NULL';
        }
        if (constraints.includes('UNIQUE')) {
            alterQuery += ' UNIQUE';
        }
        if (constraints.includes('GENERATED ALWAYS AS IDENTITY')) {
            alterQuery += ' GENERATED ALWAYS AS IDENTITY';
        }
        await client.query(alterQuery);
    }

    async modifyColumn(database: string, tableName: string, oldColumnName: string, newColumnName: string, columnType: string, constraints: string[], defaultValue?: string): Promise<void> {
        const client = await this.getClient(database);
        
        // Get existing constraints to compare
        const existingPK = await this.getPrimaryKeys(database, tableName);
        const existingUnique = await this.getUniqueKeys(database, tableName);
        
        const isPrimaryKey = constraints.includes('PRIMARY KEY');
        const isUnique = constraints.includes('UNIQUE');
        const isAutoIncrement = constraints.includes('GENERATED ALWAYS AS IDENTITY');
        const isNotNull = constraints.includes('NOT NULL');
        
        // Rename column if name changed
        if (oldColumnName !== newColumnName) {
            await client.query(`ALTER TABLE "${tableName}" RENAME COLUMN "${oldColumnName}" TO "${newColumnName}"`);
        }
        
        // Handle PRIMARY KEY constraint
        const wasPrimaryKey = existingPK.includes(oldColumnName);
        if (isPrimaryKey && !wasPrimaryKey) {
            // Add PRIMARY KEY
            await client.query(`ALTER TABLE "${tableName}" ADD PRIMARY KEY ("${newColumnName}")`);
        } else if (!isPrimaryKey && wasPrimaryKey) {
            // Drop PRIMARY KEY - need to find constraint name
            const pkQuery = await client.query(`
                SELECT conname 
                FROM pg_constraint 
                WHERE conrelid = $1::regclass AND contype = 'p'
            `, [tableName]);
            if (pkQuery.rows.length > 0) {
                await client.query(`ALTER TABLE "${tableName}" DROP CONSTRAINT "${pkQuery.rows[0].conname}"`);
            }
        }
        
        // Handle UNIQUE constraint
        const wasUnique = existingUnique.includes(oldColumnName);
        if (isUnique && !wasUnique) {
            // Add UNIQUE
            await client.query(`ALTER TABLE "${tableName}" ADD UNIQUE ("${newColumnName}")`);
        } else if (!isUnique && wasUnique) {
            // Drop UNIQUE - need to find constraint name
            const uniqueQuery = await client.query(`
                SELECT conname 
                FROM pg_constraint 
                WHERE conrelid = $1::regclass AND contype = 'u' AND $2 = ANY(SELECT attname FROM pg_attribute WHERE attrelid = conrelid AND attnum = ANY(conkey))
            `, [tableName, newColumnName]);
            if (uniqueQuery.rows.length > 0) {
                await client.query(`ALTER TABLE "${tableName}" DROP CONSTRAINT "${uniqueQuery.rows[0].conname}"`);
            }
        }
        
        // Change data type (if not IDENTITY)
        if (!isAutoIncrement) {
            await client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${newColumnName}" TYPE ${columnType}`);
        }
        
        // Handle IDENTITY (AUTO_INCREMENT)
        const hasIdentity = await client.query(`
            SELECT column_default 
            FROM information_schema.columns 
            WHERE table_name = $1 AND column_name = $2 AND column_default LIKE 'nextval%'
        `, [tableName, newColumnName]);
        const wasAutoIncrement = hasIdentity.rows.length > 0;
        
        if (isAutoIncrement && !wasAutoIncrement) {
            // Add IDENTITY
            await client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${newColumnName}" ADD GENERATED ALWAYS AS IDENTITY`);
        } else if (!isAutoIncrement && wasAutoIncrement) {
            // Drop IDENTITY
            await client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${newColumnName}" DROP IDENTITY IF EXISTS`);
        }
        
        // Set/Drop default (only if not AUTO_INCREMENT)
        if (!isAutoIncrement) {
            if (defaultValue !== undefined && defaultValue !== '') {
                let defaultExpr;
                if (['CURRENT_TIMESTAMP', 'NULL', 'TRUE', 'FALSE', 'NOW()'].includes(defaultValue.toUpperCase())) {
                    defaultExpr = defaultValue.toUpperCase();
                } else if (!isNaN(Number(defaultValue))) {
                    defaultExpr = defaultValue;
                } else {
                    defaultExpr = `'${defaultValue.replace(/'/g, "''")}'`;
                }
                await client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${newColumnName}" SET DEFAULT ${defaultExpr}`);
            } else {
                await client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${newColumnName}" DROP DEFAULT`);
            }
        }
        
        // Set/Drop NOT NULL
        if (isNotNull) {
            await client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${newColumnName}" SET NOT NULL`);
        } else {
            await client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${newColumnName}" DROP NOT NULL`);
        }
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

    async executeQuery(query: string, database?: string): Promise<QueryResult> {
        const client = await this.getClient(database);
        const result = await client.query(query);
        
        // Try to get table name from query (simple SELECT * FROM table pattern)
        let tableName: string | null = null;
        const tableMatch = query.match(/FROM\s+["`]?(\w+)["`]?/i);
        if (tableMatch) {
            tableName = tableMatch[1];
        }
        
        // If we have a table name and fields, get metadata
        let fieldsWithMetadata = result.fields?.map(field => ({ 
            name: field.name,
            dataType: field.dataTypeID ? this.getPostgresType(field.dataTypeID) : undefined,
            isPrimaryKey: false,
            isUnique: false,
            isAutoIncrement: false,
            isNullable: true
        }));
        
        if (tableName && result.fields && result.fields.length > 0) {
            try {
                // Get column metadata
                const metadataQuery = `
                    SELECT 
                        c.column_name,
                        c.is_nullable,
                        c.column_default,
                        EXISTS(
                            SELECT 1 FROM information_schema.table_constraints tc
                            JOIN information_schema.key_column_usage kcu 
                                ON tc.constraint_name = kcu.constraint_name
                            WHERE tc.constraint_type = 'PRIMARY KEY'
                            AND kcu.table_name = c.table_name
                            AND kcu.column_name = c.column_name
                        ) as is_primary_key,
                        EXISTS(
                            SELECT 1 FROM information_schema.table_constraints tc
                            JOIN information_schema.key_column_usage kcu 
                                ON tc.constraint_name = kcu.constraint_name
                            WHERE tc.constraint_type = 'UNIQUE'
                            AND kcu.table_name = c.table_name
                            AND kcu.column_name = c.column_name
                        ) as is_unique
                    FROM information_schema.columns c
                    WHERE c.table_name = $1
                    AND c.table_schema = 'public'
                `;
                
                const metadata = await client.query(metadataQuery, [tableName]);
                const metadataMap = new Map(metadata.rows.map((row: any) => [row.column_name, row]));
                
                fieldsWithMetadata = result.fields.map(field => {
                    const meta = metadataMap.get(field.name);
                    return {
                        name: field.name,
                        dataType: field.dataTypeID ? this.getPostgresType(field.dataTypeID) : undefined,
                        isPrimaryKey: meta?.is_primary_key || false,
                        isUnique: meta?.is_unique || false,
                        isAutoIncrement: meta?.column_default?.includes('nextval') || false,
                        isNullable: meta?.is_nullable === 'YES'
                    };
                });
            } catch (error) {
                // If metadata fetch fails, use basic info
                console.error('Failed to fetch column metadata:', error);
            }
        }
        
        return {
            rows: result.rows,
            fields: fieldsWithMetadata,
            affectedRows: result.rowCount || undefined
        };
    }

    private getPostgresType(typeId: number): string {
        const types: { [key: number]: string } = {
            16: 'boolean',
            20: 'bigint',
            21: 'smallint',
            23: 'integer',
            25: 'text',
            700: 'real',
            701: 'double precision',
            1043: 'varchar',
            1082: 'date',
            1114: 'timestamp',
            1184: 'timestamp with time zone',
        };
        return types[typeId] || `type(${typeId})`;
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