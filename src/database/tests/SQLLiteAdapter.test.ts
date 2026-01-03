import { SQLiteAdapter } from '../SQLLiteAdapter';
import { Connection } from '../../types'; 
import initSqlJs from 'sql.js';
import { Client as SSHClient } from 'ssh2';
import { EventEmitter } from 'events';
import * as fs from 'fs';

// --- Mocks ---

// 1. Mock FS to verify file reading (init) and writing (save)
jest.mock('fs', () => {
    return {
        existsSync: jest.fn().mockReturnValue(true),
        readFileSync: jest.fn().mockReturnValue(Buffer.from('mock-db-content')),
        writeFileSync: jest.fn(), // Crucial for checking persistence
    };
});

// 2. Mock sql.js
const mockStmt = {
    bind: jest.fn(),
    step: jest.fn(),
    getAsObject: jest.fn(),
    free: jest.fn()
};

const mockDbInstance = {
    prepare: jest.fn(),
    run: jest.fn(),
    exec: jest.fn(), // Used for getting changes() and last_insert_rowid()
    export: jest.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
    close: jest.fn()
};

const mockSqlEngine = {
    Database: jest.fn().mockImplementation(() => mockDbInstance)
};

jest.mock('sql.js', () => {
    return jest.fn().mockResolvedValue(mockSqlEngine);
});

jest.mock('ssh2');

describe('SQLiteAdapter (sql.js)', () => {
    let adapter: SQLiteAdapter;
    let mockSSHClient: any;
    let mockSSHStream: any;

    const createConfig = (isRemote: boolean): Connection => ({
        name: 'Test DB',
        type: 'SQLite',
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

        // Default sql.js behavior
        mockDbInstance.prepare.mockReturnValue(mockStmt);
        // Default exec returns "0 changes" structure
        mockDbInstance.exec.mockReturnValue([{ values: [[0]] }]); 

        // SSH Mocks
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
            expect(() => new SQLiteAdapter(invalidConfig)).toThrow('requires a valid connection object');
        });

        test('should load database from disk on query', async () => {
            adapter = new SQLiteAdapter(createConfig(false));
            
            // Trigger lazy load
            await adapter.testConnection();

            expect(initSqlJs).toHaveBeenCalled();
            expect(fs.readFileSync).toHaveBeenCalledWith('./test.db');
            expect(mockSqlEngine.Database).toHaveBeenCalled();
        });
    });

    describe('Local Mode', () => {
        beforeEach(() => {
            adapter = new SQLiteAdapter(createConfig(false));
        });

        test('testConnection should execute SELECT 1 locally', async () => {
            // Mock sequence for SELECT: prepare -> bind -> step(true) -> get -> step(false) -> free
            mockStmt.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
            mockStmt.getAsObject.mockReturnValue({ '1': 1 });

            await adapter.testConnection();

            expect(mockDbInstance.prepare).toHaveBeenCalledWith('SELECT 1');
            expect(mockStmt.step).toHaveBeenCalled();
            expect(mockStmt.free).toHaveBeenCalled();
        });

        test('should save to disk after WRITE operations', async () => {
            // Mock exec to return 1 affected row for the metadata check
            mockDbInstance.exec.mockReturnValue([{ values: [[1]] }]); 

            await adapter.createTable('main', 'users', [
                { name: 'id', type: 'INTEGER', constraints: ['PRIMARY KEY'] }
            ]);

            expect(mockDbInstance.run).toHaveBeenCalled();
            expect(mockDbInstance.export).toHaveBeenCalled();
            // Verify persistence
            expect(fs.writeFileSync).toHaveBeenCalledWith('./test.db', expect.anything());
        });

        test('should NOT save to disk after READ operations', async () => {
            mockStmt.step.mockReturnValue(false); // No rows

            await adapter.query('main', 'SELECT * FROM users');

            expect(mockDbInstance.prepare).toHaveBeenCalled();
            expect(fs.writeFileSync).not.toHaveBeenCalled();
        });

        test('createTable should generate correct SQL', async () => {
            await adapter.createTable('main', 'users', [
                { name: 'id', type: 'INTEGER', constraints: ['PRIMARY KEY', 'AUTO_INCREMENT'] },
                { name: 'name', type: 'TEXT', constraints: ['NOT NULL'] }
            ]);

            const expectedSQL = `CREATE TABLE IF NOT EXISTS "users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL)`;
            expect(mockDbInstance.run).toHaveBeenCalledWith(expectedSQL, expect.any(Array));
        });
    });

    describe('Remote SSH Mode', () => {
        beforeEach(() => {
            adapter = new SQLiteAdapter(createConfig(true));
        });

        const setupSSHExec = (stdout: string, stderr: string = '', exitCode: number = 0) => {
            mockSSHClient.exec.mockImplementation((cmd: string, cb: Function) => {
                cb(null, mockSSHStream);
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
            
            expect(mockSSHClient.connect).toHaveBeenCalled();
            expect(mockSSHClient.exec).toHaveBeenCalledWith(
                expect.stringContaining('sqlite3 -json "/var/www/db.sqlite"'), 
                expect.any(Function)
            );
        });

        test('should interpolate parameters safely', async () => {
            setupSSHExec('[]');
            await adapter.query('main', 'SELECT * FROM t WHERE a = ?', ["O'Reilly"]);
            
            const cmd = mockSSHClient.exec.mock.calls[0][0];
            expect(cmd).toContain(`a = 'O''Reilly'`);
        });
    });

    describe('Export Functionality', () => {
        beforeEach(() => {
            adapter = new SQLiteAdapter(createConfig(false));
        });

        test('exportTable should handle Uint8Array/Buffer correctly', async () => {
            // Mock schema query
            mockStmt.step
                .mockReturnValueOnce(true) // Schema row
                .mockReturnValueOnce(false) // End schema
                .mockReturnValueOnce(true) // Data row
                .mockReturnValueOnce(false); // End data

            mockStmt.getAsObject
                .mockReturnValueOnce({ sql: 'CREATE TABLE blobs (data BLOB)' })
                .mockReturnValueOnce({ data: new Uint8Array([0xFF, 0x0A]) });

            const sql = await adapter.exportTable('main', 'blobs', true);
            expect(sql).toContain(`INSERT INTO "blobs" ("data") VALUES (X'ff0a');`);
        });
    });

    describe('Schema Modifications', () => {
        beforeEach(() => {
            adapter = new SQLiteAdapter(createConfig(false));
        });

        test('modifyColumn should perform full migration transaction', async () => {
            // Setup a sequence of behaviors for prepare/step
            // 1. getColumns (PRAGMA table_info)
            mockStmt.step.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
            mockStmt.getAsObject
                .mockReturnValueOnce({ name: 'id', type: 'INTEGER', pk: 1, notnull: 0 })
                .mockReturnValueOnce({ name: 'old', type: 'TEXT', pk: 0, notnull: 0 });

            await adapter.modifyColumn('main', 'users', 'old', 'new', 'INTEGER', ['NOT NULL']);

            // Verify the sequence of Write operations
            const writeCalls = mockDbInstance.run.mock.calls.map(c => c[0]);
            
            expect(writeCalls).toEqual(expect.arrayContaining([
                'BEGIN TRANSACTION',
                expect.stringContaining('RENAME TO'),
                expect.stringContaining('CREATE TABLE'),
                expect.stringContaining('INSERT INTO'),
                expect.stringContaining('DROP TABLE'),
                'COMMIT'
            ]));

            // Verify saving occurred
            expect(fs.writeFileSync).toHaveBeenCalled();
        });

        test('modifyColumn should ROLLBACK on error', async () => {
            // 1. Allow getColumns to succeed
            mockStmt.step.mockReturnValueOnce(false); // No columns found, fine for this test

            // 2. Make db.run throw on the table rename part
            mockDbInstance.run.mockImplementation((sql: string) => {
                if (sql.includes('RENAME TO')) {
                    throw new Error('Disk full');
                }
            });

            await expect(adapter.modifyColumn('main', 't', 'c', 'c', 'INT', [])).rejects.toThrow('Disk full');
            
            // Check that ROLLBACK was attempted
            expect(mockDbInstance.run).toHaveBeenCalledWith('ROLLBACK', expect.anything());
        });
    });
});