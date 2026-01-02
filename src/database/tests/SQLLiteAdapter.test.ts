import { SQLiteAdapter } from '../SQLLiteAdapter'; 
import { Connection } from '../../types'; 
import sqlite3 from 'sqlite3';
import { Client as SSHClient } from 'ssh2';
import { EventEmitter } from 'events';

jest.mock('fs', () => {
    const originalFs = jest.requireActual('fs');
    return {
        ...originalFs,
        readFileSync: jest.fn().mockReturnValue('mock-private-key'),
    };
});
jest.mock('sqlite3');
jest.mock('ssh2');

describe('SQLiteAdapter', () => {
    let adapter: SQLiteAdapter;
    let mockSqliteDb: any;
    let mockSSHClient: any;
    let mockSSHStream: any;

    const createConfig = (isRemote: boolean): Connection => ({
        name: 'Test DB',
        type: 'SQLite', // Corrected type casing if necessary
        host: '',
        port: 0,
        username: '',
        password: '',
        sqlite: {
            filePath: isRemote ? '/var/www/db.sqlite' : './test.db',
            useSSH: isRemote,
            sshConfig: isRemote ? {
                host: '1.2.3.4',
                port: 22,
                username: 'root',
                password: 'password'
            } : undefined
        }
    });

    beforeEach(() => {
        jest.clearAllMocks();

        mockSqliteDb = {
            all: jest.fn(),
            run: jest.fn(),
            close: jest.fn((cb) => cb(null)),
        };

        (sqlite3.Database as unknown as jest.Mock).mockImplementation((path, cb) => {
            if (cb) {
                process.nextTick(() => cb(null)); 
            }
            return mockSqliteDb;
        });

        mockSSHClient = new EventEmitter();
        mockSSHClient.connect = jest.fn().mockReturnThis();
        mockSSHClient.end = jest.fn();
        mockSSHClient.exec = jest.fn();
        
        mockSSHStream = new EventEmitter();
        mockSSHStream.stderr = new EventEmitter();

        (SSHClient as unknown as jest.Mock).mockImplementation(() => mockSSHClient);
    });

    afterEach(async () => {
        if (adapter) {
            await adapter.close();
        }
    });

    describe('Initialization', () => {
        test('should throw error if sqlite config is missing', () => {
            const invalidConfig = { name: 'Bad', type: 'SQLite' } as Connection;
            expect(() => new SQLiteAdapter(invalidConfig)).toThrow('requires sqlite configuration');
        });

        test('should initialize successfully with valid config', () => {
            const config = createConfig(false);
            adapter = new SQLiteAdapter(config); 
            expect(adapter).toBeDefined();
        });
    });

    describe('Local Mode', () => {
        beforeEach(() => {
            adapter = new SQLiteAdapter(createConfig(false));
        });

        test('testConnection should execute SELECT 1 locally', async () => {
            mockSqliteDb.all.mockImplementation((sql: string, params: any[], cb: Function) => {
                cb(null, [{ 1: 1 }]);
            });

            await adapter.testConnection();

            expect(sqlite3.Database).toHaveBeenCalledWith('./test.db', expect.any(Function));
            expect(mockSqliteDb.all).toHaveBeenCalledWith('SELECT 1', [], expect.any(Function));
        });

        test('getDatabases should return ["main"] on failure (fallback)', async () => {
            mockSqliteDb.all.mockImplementation((sql: string, params: any[], cb: Function) => {
                cb(new Error('Pragma not supported'));
            });

            const dbs = await adapter.getDatabases();
            expect(dbs).toEqual(['main']);
        });

        test('createTable should generate correct SQL', async () => {
            mockSqliteDb.run.mockImplementation(function(this: any, sql: string, params: any[], cb: Function) {
                cb.call({ changes: 0, lastID: 0 }, null);
            });

            await adapter.createTable('main', 'users', [
                { name: 'id', type: 'INTEGER', constraints: ['PRIMARY KEY', 'AUTO_INCREMENT'] },
                { name: 'name', type: 'TEXT', constraints: ['NOT NULL'] }
            ]);

            const expectedSQL = `CREATE TABLE IF NOT EXISTS "users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL)`;
            expect(mockSqliteDb.run).toHaveBeenCalledWith(expectedSQL, expect.any(Array), expect.any(Function));
        });
    });

    describe('Remote SSH Mode', () => {
        beforeEach(() => {
            adapter = new SQLiteAdapter(createConfig(true));
        });

        const setupSSHExec = (stdout: string, stderr: string = '', exitCode: number = 0) => {
            mockSSHClient.exec.mockImplementation((cmd: string, cb: Function) => {
                cb(null, mockSSHStream);
                // Emit events asynchronously to mimic real stream
                process.nextTick(() => {
                    if (stdout) mockSSHStream.emit('data', Buffer.from(stdout));
                    if (stderr) mockSSHStream.stderr.emit('data', Buffer.from(stderr));
                    mockSSHStream.emit('close', exitCode);
                });
            });
            
            mockSSHClient.connect.mockImplementation(() => {
                process.nextTick(() => mockSSHClient.emit('ready'));
                return mockSSHClient;
            });
        };

        test('should connect via SSH and execute sqlite3 command', async () => {
            setupSSHExec('[{"1":1}]'); 

            await adapter.testConnection();

            expect(mockSSHClient.connect).toHaveBeenCalledWith(expect.objectContaining({
                host: '1.2.3.4',
                username: 'root'
            }));
            
            const expectedCmd = `sqlite3 -json "/var/www/db.sqlite" "SELECT 1"`;
            expect(mockSSHClient.exec).toHaveBeenCalledWith(expectedCmd, expect.any(Function));
        });

        test('should handle SSH connection errors', async () => {
            mockSSHClient.connect.mockImplementation(() => {
                // Emit error asynchronously
                process.nextTick(() => mockSSHClient.emit('error', new Error('Auth failed')));
                return mockSSHClient;
            });

            await expect(adapter.testConnection()).rejects.toThrow('Auth failed');
        });

        test('should handle remote sqlite3 errors (non-zero exit code)', async () => {
            setupSSHExec('', 'Error: database is locked', 1);

            await expect(adapter.testConnection()).rejects.toThrow('Remote SQLite Error (Code 1): Error: database is locked');
        });

        test('should interpolate parameters safely for SSH CLI', async () => {
            setupSSHExec('[]');

            await adapter.query('main', 'SELECT * FROM users WHERE name = ? AND active = ?', ["O'Reilly", true]);

            const calledCmd = mockSSHClient.exec.mock.calls[0][0];
            expect(calledCmd).toContain(`name = 'O''Reilly'`);
            expect(calledCmd).toContain(`active = 1`);
        });
    });

    describe('Export Functionality', () => {
        beforeEach(() => {
            adapter = new SQLiteAdapter(createConfig(false));
            mockSqliteDb.run.mockImplementation((sql: string, params: any[], cb: Function) => cb.call({}, null));
        });

        test('exportTable should handle Buffers correctly', async () => {
            mockSqliteDb.all.mockImplementation((sql: string, params: any[], cb: Function) => {
                if (sql.includes('sqlite_master')) {
                    cb(null, [{ sql: 'CREATE TABLE blobs (data BLOB)' }]);
                } else {
                    cb(null, [{ data: Buffer.from([0xFF, 0x0A]) }]); 
                }
            });

            const sql = await adapter.exportTable('main', 'blobs', true);
            expect(sql).toContain(`INSERT INTO "blobs" ("data") VALUES (X'ff0a');`);
        });

        test('exportTable should handle string escaping', async () => {
            mockSqliteDb.all.mockImplementation((sql: string, params: any[], cb: Function) => {
                if (sql.includes('sqlite_master')) {
                    cb(null, [{ sql: 'CREATE TABLE texts (val TEXT)' }]);
                } else {
                    cb(null, [{ val: "User's data" }]);
                }
            });

            const sql = await adapter.exportTable('main', 'texts', true);
            expect(sql).toContain(`VALUES ('User''s data');`);
        });
    });

    describe('Schema Modifications', () => {
        beforeEach(() => {
            adapter = new SQLiteAdapter(createConfig(false));
        });

        test('modifyColumn should perform full migration transaction', async () => {
            // Mock getColumns
            mockSqliteDb.all.mockImplementationOnce((sql: string, p: any, cb: Function) => cb(null, [
                { name: 'id', type: 'INTEGER', pk: 1, notnull: 0, dflt_value: null },
                { name: 'oldCol', type: 'TEXT', pk: 0, notnull: 0, dflt_value: null }
            ]));

            // Mock subsequent calls (PRAGMA table_info for PKs, etc)
            mockSqliteDb.all.mockImplementation((sql: string, p: any, cb: Function) => cb(null, []));
            
            const runSpy = mockSqliteDb.run;
            runSpy.mockImplementation(function(this: any, sql: string, params: any[], cb: Function) {
                cb.call({ changes: 1 }, null);
            });

            await adapter.modifyColumn('main', 'users', 'oldCol', 'newCol', 'INTEGER', ['NOT NULL']);

            expect(runSpy).toHaveBeenCalledWith('BEGIN TRANSACTION', expect.anything(), expect.anything());
            expect(runSpy).toHaveBeenCalledWith(expect.stringContaining('RENAME TO'), expect.anything(), expect.anything());
            expect(runSpy).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE'), expect.anything(), expect.anything());
            expect(runSpy).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO'), expect.anything(), expect.anything());
            expect(runSpy).toHaveBeenCalledWith(expect.stringContaining('DROP TABLE'), expect.anything(), expect.anything());
            expect(runSpy).toHaveBeenCalledWith('COMMIT', expect.anything(), expect.anything());
        });

        test('modifyColumn should ROLLBACK on error', async () => {
            mockSqliteDb.all.mockImplementation((sql: string, p: any, cb: Function) => cb(null, []));

            mockSqliteDb.run.mockImplementation(function(this: any, sql: string, params: any[], cb: Function) {
                if (sql === 'BEGIN TRANSACTION') {
                    cb.call({}, null);
                } else {
                    cb(new Error('Disk full'));
                }
            });

            await expect(adapter.modifyColumn('main', 't', 'c', 'c', 'INT', [])).rejects.toThrow('Disk full');
            
            expect(mockSqliteDb.run).toHaveBeenCalledWith('ROLLBACK', expect.anything(), expect.anything());
        });
    });
});