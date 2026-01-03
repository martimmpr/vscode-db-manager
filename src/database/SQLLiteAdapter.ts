import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database, QueryExecResult } from 'sql.js';
import { Client as SSHClient } from 'ssh2';
import { Buffer } from 'buffer';
import { Connection, SQLiteConnectionParams } from '../types';
import { IDatabaseAdapter, ColumnDefinition, ColumnInfo, QueryResult } from './IDatabaseAdapter';

// --- Internal Types ---
interface TableInfoRow {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: any;
    pk: number;
}

interface IndexListRow {
    seq: number;
    name: string;
    unique: number;
    origin: string;
    partial: number;
}

interface IndexInfoRow {
    seqno: number;
    cid: number;
    name: string;
}

interface SqliteMasterRow {
    type: string;
    name: string;
    tbl_name: string;
    rootpage: number;
    sql: string;
}

export class SQLiteAdapter implements IDatabaseAdapter {
    private connectionConfig: Connection;
    private db: Database | null = null;
    private SQL: any = null; // The initialized sql.js engine
    private sshClient: SSHClient | null = null;

    constructor(connection: Connection) {
        if (!connection || !connection.sqlite) {
            throw new Error('SQLiteAdapter requires a valid connection object with sqlite configuration.');
        }
        this.connectionConfig = connection;
    }

    /**
     * Initialize the sql.js engine and load the database file.
     * sql.js initialization is asynchronous.
     */
    private async initLocalConnection(config: SQLiteConnectionParams): Promise<Database> {
        if (this.db) return this.db;

        // 1. Initialize the WASM engine
        if (!this.SQL) {
            try {
                // Locate the WASM file in the dist folder
                const wasmPath = path.join(__dirname, '..', 'sql-wasm.wasm');
                
                this.SQL = await initSqlJs({
                    // Point to the local wasm file so it doesn't try to fetch from CDN
                    locateFile: () => wasmPath
                });
            } catch (e) {
                // Fallback: try loading without path (depends on environment)
                this.SQL = await initSqlJs();
            }
        }

        // 2. Read the file from disk (if it exists)
        let buffer: Buffer | null = null;
        if (config.filePath && config.filePath !== ':memory:' && fs.existsSync(config.filePath)) {
            try {
                buffer = fs.readFileSync(config.filePath);
            } catch (err) {
                throw new Error(`Failed to read SQLite file: ${err}`);
            }
        }

        // 3. Create the DB instance (from file buffer or new)
        this.db = new this.SQL.Database(buffer);
        return this.db!;
    }

    /**
     * Since sql.js is in-memory, we must manually save changes back to disk.
     */
    private saveDatabase(config: SQLiteConnectionParams) {
        if (!this.db || !config.filePath || config.filePath === ':memory:') return;

        try {
            const data = this.db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(config.filePath, buffer);
        } catch (err) {
            console.error('Failed to save SQLite database to disk:', err);
            throw new Error(`Failed to save database: ${err}`);
        }
    }

    private async queryInternal<T>(sql: string, params: any[] = []): Promise<T[]> {
        const config = this.connectionConfig.sqlite!;

        if (config.useSSH && config.sshConfig) {
            return this.queryRemote<T>(sql, params, config);
        } else {
            return this.queryLocal<T>(sql, params, config);
        }
    }

    private async queryLocal<T>(sql: string, params: any[], config: SQLiteConnectionParams): Promise<T[]> {
        const db = await this.initLocalConnection(config);
        
        // sql.js expects params as an array or object, but it handles binding differently
        // We need to ensure params are JS primitives
        const safeParams = params.map(p => {
             if (typeof p === 'boolean') return p ? 1 : 0;
             return p;
        });

        try {
            // Determine if this is a read or write for saving purposes
            const upperSql = sql.trim().toUpperCase();
            const isWrite = /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA)/.test(upperSql) && !upperSql.startsWith('PRAGMA TABLE_INFO');

            // .exec() returns an array of result sets, but it doesn't support binding easily.
            // .prepare() + .step() is safer for params, but .run() is easiest for writes.
            
            if (upperSql.startsWith('SELECT') || upperSql.startsWith('PRAGMA')) {
                // For SELECT, we use prepare/step/getAsObject to get nice JSON
                const stmt = db.prepare(sql);
                stmt.bind(safeParams);
                
                const rows: T[] = [];
                while (stmt.step()) {
                    rows.push(stmt.getAsObject() as unknown as T);
                }
                stmt.free();
                return rows;
            } else {
                // For Writes
                db.run(sql, safeParams);
                
                // Emulate "affectedRows" and "insertId"
                // sql.js doesn't give these easily in .run(), so we query them
                const changes = db.exec("SELECT changes()")[0]?.values[0][0] as number || 0;
                const lastId = db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] as number || 0;

                if (isWrite) {
                    this.saveDatabase(config);
                }

                return [{ affectedRows: changes, insertId: lastId }] as unknown as T[];
            }

        } catch (err: any) {
            throw new Error(`Local SQLite Error: ${err.message}`);
        }
    }

    // --- SSH Implementation (Unchanged, uses CLI) ---
    private async getSSHConnection(config: SQLiteConnectionParams): Promise<SSHClient> {
        if (this.sshClient) return this.sshClient;

        return new Promise((resolve, reject) => {
            const conn = new SSHClient();
            conn.on('ready', () => {
                this.sshClient = conn;
                resolve(conn);
            }).on('error', (err) => {
                reject(err);
            }).connect({
                host: config.sshConfig!.host,
                port: config.sshConfig!.port,
                username: config.sshConfig!.username,
                password: config.sshConfig!.password,
                privateKey: config.sshConfig!.privateKeyPath 
                    ? fs.readFileSync(config.sshConfig!.privateKeyPath) 
                    : undefined,
                passphrase: config.sshConfig!.passphrase
            });
        });
    }

    private async queryRemote<T>(sql: string, params: any[], config: SQLiteConnectionParams): Promise<T[]> {
        const conn = await this.getSSHConnection(config);
        const populatedSql = this.interpolateParams(sql, params);
        const cmd = `sqlite3 -json "${config.filePath}" "${populatedSql.replace(/"/g, '\\"')}"`;

        return new Promise((resolve, reject) => {
            conn.exec(cmd, (err, stream) => {
                if (err) return reject(err);
                let stdout = '';
                let stderr = '';

                stream.on('close', (code: number) => {
                    if (code !== 0) {
                        reject(new Error(`Remote SQLite Error (Code ${code}): ${stderr || 'Unknown'}`));
                    } else {
                        try {
                            if (!stdout.trim()) resolve([] as T[]);
                            else resolve(JSON.parse(stdout));
                        } catch (e) {
                            reject(new Error(`Failed to parse remote response: ${e}`));
                        }
                    }
                }).on('data', (data: Buffer) => stdout += data.toString())
                  .stderr.on('data', (data: Buffer) => stderr += data.toString());
            });
        });
    }

    private interpolateParams(sql: string, params: any[]): string {
        let res = sql;
        for (const param of params) {
            let safe = 'NULL';
            if (param !== null && param !== undefined) {
                if (typeof param === 'number') safe = param.toString();
                else if (typeof param === 'boolean') safe = param ? '1' : '0';
                else safe = `'${String(param).replace(/'/g, "''")}'`;
            }
            res = res.replace('?', safe);
        }
        return res;
    }

    private closeSSH(): void {
        if (this.sshClient) {
            this.sshClient.end();
            this.sshClient = null;
        }
    }

    // --- Standard Interface Implementation ---

    async testConnection(): Promise<void> {
        await this.queryInternal('SELECT 1');
    }

    async getDatabases(): Promise<string[]> {
        // SQLite only has one DB per file usually attached as 'main'
        return ['main'];
    }

    async getTables(database: string): Promise<string[]> {
        const rows = await this.queryInternal<SqliteMasterRow>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        );
        return rows.map(row => row.name);
    }

    async createTable(database: string, tableName: string, columns: ColumnDefinition[]): Promise<void> {
        const primaryKeys: string[] = [];
        const uniqueKeys: string[] = [];
        
        const columnDefs = columns.map(col => {
            let type = col.type;
            const isAutoInc = col.constraints.includes('GENERATED ALWAYS AS IDENTITY') || 
                              col.constraints.includes('AUTO_INCREMENT');

            if (isAutoInc) type = 'INTEGER'; 

            let def = `"${col.name}" ${type}`;
            const constraints = col.constraints.filter(c => {
                if (c === 'GENERATED ALWAYS AS IDENTITY' || c === 'AUTO_INCREMENT') return false;
                if (c === 'PRIMARY KEY' && isAutoInc) return false; 
                if (c === 'PRIMARY KEY') { primaryKeys.push(col.name); return false; }
                if (c === 'UNIQUE') { uniqueKeys.push(col.name); return false; }
                return true;
            });
            
            if (isAutoInc) def += ' PRIMARY KEY AUTOINCREMENT';
            if (constraints.length > 0) def += ' ' + constraints.join(' ');
            return def;
        }).join(', ');
        
        let tableConstraints = '';
        if (primaryKeys.length > 0) tableConstraints += `, PRIMARY KEY ("${primaryKeys.join('", "')}")`;
        uniqueKeys.forEach(uk => tableConstraints += `, UNIQUE ("${uk}")`);
        
        await this.queryInternal(`CREATE TABLE IF NOT EXISTS "${tableName}" (${columnDefs}${tableConstraints})`);
    }

    async deleteTable(database: string, tableName: string): Promise<void> {
        await this.queryInternal(`DROP TABLE "${tableName}"`);
    }

    async renameTable(database: string, oldTableName: string, newTableName: string): Promise<void> {
        await this.queryInternal(`ALTER TABLE "${oldTableName}" RENAME TO "${newTableName}"`);
    }

    async addColumn(database: string, tableName: string, columnName: string, columnType: string, constraints: string[], defaultValue?: string): Promise<void> {
        let alterQuery = `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${columnType}`;
        if (defaultValue !== undefined && defaultValue !== '') {
             if (['CURRENT_TIMESTAMP', 'NULL', 'TRUE', 'FALSE'].includes(defaultValue.toUpperCase())) {
                alterQuery += ` DEFAULT ${defaultValue.toUpperCase()}`;
            } else if (!isNaN(Number(defaultValue))) {
                alterQuery += ` DEFAULT ${defaultValue}`;
            } else {
                alterQuery += ` DEFAULT '${defaultValue.replace(/'/g, "''")}'`;
            }
        }
        if (constraints.includes('NOT NULL')) alterQuery += ' NOT NULL';
        if (constraints.includes('UNIQUE')) alterQuery += ' UNIQUE';
        await this.queryInternal(alterQuery);
    }

    async modifyColumn(database: string, tableName: string, oldColumnName: string, newColumnName: string, columnType: string, constraints: string[], defaultValue?: string): Promise<void> {
        // SQLite doesn't support direct column modification, requires recreation
        const currentColumns = await this.getColumns(database, tableName);
        const currentPKs = await this.getPrimaryKeys(database, tableName);
        
        const newColsDef: ColumnDefinition[] = currentColumns.map(col => {
            if (col.column_name === oldColumnName) {
                return { name: newColumnName, type: columnType, constraints };
            } else {
                const colConstraints: string[] = [];
                if (col.is_nullable === 'NO') colConstraints.push('NOT NULL');
                if (currentPKs.includes(col.column_name)) colConstraints.push('PRIMARY KEY');
                return { name: col.column_name, type: col.data_type, constraints: colConstraints };
            }
        });

        await this.queryInternal('BEGIN TRANSACTION');
        try {
            const tempTableName = `${tableName}_old_${Date.now()}`;
            await this.queryInternal(`ALTER TABLE "${tableName}" RENAME TO "${tempTableName}"`);
            await this.createTable(database, tableName, newColsDef);

            const columnMapping = currentColumns.map(c => c.column_name === oldColumnName ? `"${newColumnName}"` : `"${c.column_name}"`).join(', ');
            const sourceMapping = currentColumns.map(c => `"${c.column_name}"`).join(', ');

            await this.queryInternal(`INSERT INTO "${tableName}" (${columnMapping}) SELECT ${sourceMapping} FROM "${tempTableName}"`);
            await this.queryInternal(`DROP TABLE "${tempTableName}"`);
            await this.queryInternal('COMMIT');
        } catch (error) {
            await this.queryInternal('ROLLBACK');
            throw error;
        }
    }

    async removeColumn(database: string, tableName: string, columnName: string): Promise<void> {
        await this.queryInternal(`ALTER TABLE "${tableName}" DROP COLUMN "${columnName}"`);
    }

    async getColumns(database: string, tableName: string): Promise<ColumnInfo[]> {
        const rows = await this.queryInternal<TableInfoRow>(`PRAGMA table_info("${tableName}")`);
        return rows.map(row => ({
            column_name: row.name,
            data_type: row.type,
            is_nullable: row.notnull === 0 ? 'YES' : 'NO',
            column_default: row.dflt_value
        }));
    }

    async getPrimaryKeys(database: string, tableName: string): Promise<string[]> {
        const rows = await this.queryInternal<TableInfoRow>(`PRAGMA table_info("${tableName}")`);
        return rows.filter(row => row.pk > 0).sort((a, b) => a.pk - b.pk).map(row => row.name);
    }

    async getUniqueKeys(database: string, tableName: string): Promise<string[]> {
        const indexList = await this.queryInternal<IndexListRow>(`PRAGMA index_list("${tableName}")`);
        const uniqueIndexes = indexList.filter(idx => idx.unique === 1 && idx.origin !== 'pk');
        const uniqueColumns: string[] = [];
        for (const idx of uniqueIndexes) {
            const info = await this.queryInternal<IndexInfoRow>(`PRAGMA index_info("${idx.name}")`);
            if (info.length === 1) uniqueColumns.push(info[0].name);
        }
        return uniqueColumns;
    }

    async query(database: string, query: string, params?: any[]): Promise<any> {
        return await this.queryInternal(query, params);
    }

    async executeQuery(query: string, database?: string): Promise<QueryResult> {
        const upperSql = query.trim().toUpperCase();
        
        if (upperSql.startsWith('SELECT') || upperSql.startsWith('PRAGMA')) {
            const rows = await this.queryInternal<any>(query);
            let fields: QueryResult['fields'] = undefined;
            if (rows.length > 0) {
                fields = Object.keys(rows[0]).map(key => ({
                    name: key,
                    dataType: typeof rows[0][key],
                    isPrimaryKey: false, isUnique: false, isAutoIncrement: false, isNullable: true 
                }));
            }
            return { rows, fields, affectedRows: undefined };
        } else {
            const res = await this.queryInternal<any>(query);
            const stats = Array.isArray(res) && res.length > 0 ? res[0] : res;
            return { rows: [], fields: undefined, affectedRows: stats?.affectedRows || 0 };
        }
    }

    async exportDatabase(database: string, includeData: boolean): Promise<string> {
        const tables = await this.getTables(database);
        let sql = `-- SQLite Database Export\n-- Generated: ${new Date().toISOString()}\n\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n`;
        for (const table of tables) {
            sql += await this.exportTable(database, table, includeData);
            sql += '\n\n';
        }
        sql += `COMMIT;\n`;
        return sql;
    }

    async exportTable(database: string, tableName: string, includeData: boolean): Promise<string> {
        let sql = `-- Table: ${tableName}\n`;
        const schema = await this.queryInternal<SqliteMasterRow>(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}'`);
        if (schema && schema.length > 0) {
            sql += `DROP TABLE IF EXISTS "${tableName}";\n${schema[0].sql};\n`;
        }
        if (includeData) {
            const rows = await this.queryInternal<Record<string, any>>(`SELECT * FROM "${tableName}"`);
            if (rows.length > 0) {
                 sql += `\n-- Data for table: ${tableName}\n`;
                 for (const row of rows) {
                    const colNames = Object.keys(row).map(c => `"${c}"`).join(', ');
                    const vals = Object.values(row).map(val => {
                        if (val === null) return 'NULL';
                        if (typeof val === 'number') return val;
                        if (typeof val === 'boolean') return val ? '1' : '0';
                        if (val instanceof Uint8Array || (val && (val as any).type === 'Buffer')) return `X'${Buffer.from(val as any).toString('hex')}'`;
                        return `'${String(val).replace(/'/g, "''")}'`;
                    }).join(', ');
                    sql += `INSERT INTO "${tableName}" (${colNames}) VALUES (${vals});\n`;
                 }
            }
        }
        return sql;
    }

    async close(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this.closeSSH();
    }
}