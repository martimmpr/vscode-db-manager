import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database, QueryExecResult } from 'sql.js';
import { Client as SSHClient } from 'ssh2';
import { Buffer } from 'buffer';
import { Connection, SQLiteConnectionParams } from '../types';
import { IDatabaseAdapter, ColumnDefinition, ColumnInfo, QueryResult } from './IDatabaseAdapter';

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
    private SQL: any = null; // Initialized sql.js engine
    private sshClient: SSHClient | null = null;

    constructor(connection: Connection) {
        if (!connection || !connection.sqlite) {
            throw new Error('SQLiteAdapter requires a valid connection object with sqlite configuration.');
        }
        this.connectionConfig = connection;
    }

    private async initLocalConnection(config: SQLiteConnectionParams): Promise<Database> {
        if (this.db) return this.db;

        if (!this.SQL) {
            try {
                const wasmPath = path.join(__dirname, 'sql-wasm.wasm');
                this.SQL = await initSqlJs({
                    locateFile: () => wasmPath
                });
            } catch (e) {
                this.SQL = await initSqlJs();
            }
        }

        let buffer: Buffer | null = null;
        if (config.filePath && config.filePath !== ':memory:' && fs.existsSync(config.filePath)) {
            try {
                buffer = fs.readFileSync(config.filePath);
            } catch (err) {
                throw new Error(`Failed to read SQLite file: ${err}`);
            }
        }

        this.db = new this.SQL.Database(buffer);
        return this.db!;
    }

    private saveDatabase(config: SQLiteConnectionParams) {
        if (!this.db || !config.filePath || config.filePath === ':memory:') return;

        try {
            const data = this.db.export();
            const buffer = Buffer.from(data);

            // Atomic write: write to temp file first, then rename
            const tmpPath = `${config.filePath}.tmp`;
            fs.writeFileSync(tmpPath, buffer);
            
            // Rename is atomic on most filesystems
            fs.renameSync(tmpPath, config.filePath);
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

        const safeParams = params.map(p => {
            if (p === undefined) return null;
            if (typeof p === 'boolean') return p ? 1 : 0;
            if (typeof p === 'bigint') return Number(p);
            return p;
        });

        try {
            const upperSql = sql.trim().toUpperCase();
            const isWrite = /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA)/.test(upperSql) && !upperSql.startsWith('PRAGMA TABLE_INFO');

            if (upperSql.startsWith('SELECT') || upperSql.startsWith('PRAGMA')) {
                const stmt = db.prepare(sql);
                stmt.bind(safeParams);
                
                const rows: T[] = [];
                while (stmt.step()) {
                    rows.push(stmt.getAsObject() as unknown as T);
                }

                stmt.free();
                return rows;
            } else {
                db.run(sql, safeParams);
                
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

    private async getSSHConnection(config: SQLiteConnectionParams): Promise<SSHClient> {
        if (this.sshClient) {
            try {
                // Connection exists, attempt to reuse it
                return this.sshClient;
            } catch (err) {
                // Connection is dead, clean it up
                try {
                    this.sshClient.end();
                } catch (e) {
                    // Ignore cleanup errors
                }
                this.sshClient = null;
            }
        }

        return new Promise((resolve, reject) => {
            const conn = new SSHClient();
            conn.on('ready', () => {
                this.sshClient = conn;
                resolve(conn);
            }).on('error', (err) => {
                this.sshClient = null;
                reject(err);
            }).on('end', () => {
                this.sshClient = null;
            }).connect({
                host: config.sshConfig!.host,
                port: config.sshConfig!.port,
                username: config.sshConfig!.username,
                password: config.sshConfig!.password,
                privateKey: config.sshConfig!.privateKeyPath 
                    ? fs.readFileSync(config.sshConfig!.privateKeyPath) 
                    : undefined,
                passphrase: config.sshConfig!.passphrase,
                keepaliveInterval: 10000, 
                readyTimeout: 20000 
            });
        });
    }

    private async queryRemote<T>(sql: string, params: any[], config: SQLiteConnectionParams): Promise<T[]> {
        const conn = await this.getSSHConnection(config);
        const populatedSql = this.interpolateParams(sql, params);
        const separator = "|||";
        const cmd = `sqlite3 -header -separator "${separator}" "${config.filePath}"`;

        return new Promise((resolve, reject) => {
            conn.exec(cmd, (err, stream) => {
                if (err) return reject(err);
                let stdout = '';
                let stderr = '';

                stream.on('close', (code: number) => {
                    if (code !== 0) {
                        reject(new Error(`Remote SQLite Error (Code ${code}): ${stderr || stdout || 'Unknown error'}`));
                    } else {
                        try {
                            if (!stdout.trim()) {
                                resolve([] as T[]);
                                return;
                            }

                            const lines = stdout.trim().split('\n');
                            if (lines.length < 2) {
                                resolve([] as T[]);
                                return;
                            }
                            const headers = lines[0].split(separator).map(h => h.trim());
                            const rows: any[] = [];

                            for (let i = 1; i < lines.length; i++) {
                                const line = lines[i];
                                if (!line.trim()) continue;

                                const values = line.split(separator);
                                const row: any = {};
                                
                                headers.forEach((header, index) => {
                                    let val = values[index];

                                    if (val === undefined || val === 'NULL' || val === '') {
                                        row[header] = null;
                                    } else {
                                        const trimmed = val.trim();

                                        if (trimmed !== '' && !isNaN(Number(trimmed))) {
                                            row[header] = Number(trimmed);
                                        } else {
                                            row[header] = val;
                                        }
                                    }
                                });
                                rows.push(row);
                            }

                            resolve(rows as T[]);
                        } catch (e) {
                            reject(new Error(`Failed to parse remote output: ${e}`));
                        }
                    }
                }).on('data', (data: Buffer) => {
                    stdout += data.toString();
                }).stderr.on('data', (data: Buffer) => {
                    stderr += data.toString();
                });
                stream.write(populatedSql + ";\n");
                stream.end(); 
            });
        });
    }

    private interpolateParams(sql: string, params: any[]): string {
        let index = 0;

        return sql.replace(/\?/g, () => {
            if (index >= params.length) return '?';
            const param = params[index++];
            
            if (param === null || param === undefined) return 'NULL';
            if (typeof param === 'number') return param.toString();
            if (typeof param === 'boolean') return param ? '1' : '0';

            return `'${String(param).replace(/'/g, "''")}'`;
        });
    }

    private closeSSH(): void {
        if (this.sshClient) {
            this.sshClient.end();
            this.sshClient = null;
        }
    }

    async testConnection(): Promise<void> {
        await this.queryInternal('SELECT 1');
    }

    async getDatabases(): Promise<string[]> {
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
            const isAutoInc = col.constraints.includes('GENERATED ALWAYS AS IDENTITY') || col.constraints.includes('AUTO_INCREMENT');

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
        const isUnique = constraints.includes('UNIQUE');
        const simpleConstraints = constraints.filter(c => c !== 'UNIQUE');

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
        
        if (simpleConstraints.includes('NOT NULL')) {
            alterQuery += ' NOT NULL';
        }

        await this.queryInternal(alterQuery);

        if (isUnique) {
            const indexName = `idx_${tableName}_${columnName}_${Date.now()}`;
            await this.queryInternal(`CREATE UNIQUE INDEX "${indexName}" ON "${tableName}" ("${columnName}")`);
        }
    }

    async modifyColumn(database: string, tableName: string, oldColumnName: string, newColumnName: string, columnType: string, constraints: string[], defaultValue?: string): Promise<void> {
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
            data_type: row.type.toLowerCase(),
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