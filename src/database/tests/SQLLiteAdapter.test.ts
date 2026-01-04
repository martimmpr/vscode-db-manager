import { SQLiteAdapter } from '../SQLLiteAdapter';
import { Connection } from '../../types'; 
import initSqlJs from 'sql.js';
import { Client as SSHClient } from 'ssh2';
import { EventEmitter } from 'events';
import * as fs from 'fs';

jest.mock('fs', () => {
    return {
        existsSync: jest.fn().mockReturnValue(true),
        readFileSync: jest.fn().mockReturnValue(Buffer.from('mock-db-content')),
        writeFileSync: jest.fn(),
    };
});

jest.mock('sql.js', () => jest.fn());
jest.mock('ssh2');

describe('SQLiteAdapter (sql.js)', () => {
    let adapter: SQLiteAdapter;
    
    let mockStmt: any;
    let mockDbInstance: any;
    let mockSqlEngine: any;
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

        mockStmt = {
            bind: jest.fn(),
            step: jest.fn(),
            getAsObject: jest.fn(),
            free: jest.fn()
        };

        mockDbInstance = {
            prepare: jest.fn().mockReturnValue(mockStmt),
            run: jest.fn(),
            exec: jest.fn().mockReturnValue([{ values: [[0]] }]), 
            export: jest.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
            close: jest.fn()
        };

        mockSqlEngine = {
            Database: jest.fn().mockImplementation(() => mockDbInstance)
        };

        (initSqlJs as unknown as jest.Mock).mockResolvedValue(mockSqlEngine);

        mockSSHClient = new EventEmitter();
        mockSSHClient.connect = jest.fn().mockReturnThis();
        mockSSHClient.end = jest.fn();
        mockSSHClient.exec = jest.fn();
        
        mockSSHStream = new EventEmitter();
        mockSSHStream.stderr = new EventEmitter();
        mockSSHStream.write = jest.fn();
        mockSSHStream.end = jest.fn();

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
            mockStmt.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
            mockStmt.getAsObject.mockReturnValue({ '1': 1 });
            await adapter.testConnection();
            expect(mockDbInstance.prepare).toHaveBeenCalledWith('SELECT 1');
            expect(mockStmt.step).toHaveBeenCalled();
            expect(mockStmt.free).toHaveBeenCalled();
        });

        test('should save to disk after WRITE operations', async () => {
            mockDbInstance.exec.mockReturnValue([{ values: [[1]] }]); 
            await adapter.createTable('main', 'users', [{ name: 'id', type: 'INTEGER', constraints: ['PRIMARY KEY'] }]);
            expect(mockDbInstance.run).toHaveBeenCalled();
            expect(mockDbInstance.export).toHaveBeenCalled();
            expect(fs.writeFileSync).toHaveBeenCalledWith('./test.db', expect.anything());
        });

        test('should NOT save to disk after READ operations', async () => {
            mockStmt.step.mockReturnValue(false); 
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
            setupSSHExec('1');

            await adapter.testConnection();

            expect(mockSSHClient.connect).toHaveBeenCalled();
            
            expect(mockSSHClient.exec).toHaveBeenCalledWith(
                expect.stringContaining('sqlite3 -header -separator "|||" "/var/www/db.sqlite"'), 
                expect.any(Function)
            );
            expect(mockSSHStream.write).toHaveBeenCalledWith(expect.stringContaining('SELECT 1;\n'));
            expect(mockSSHStream.end).toHaveBeenCalled();
        });

        test('should interpolate parameters safely', async () => {
            setupSSHExec(''); 
            await adapter.query('main', 'SELECT * FROM t WHERE a = ?', ["O'Reilly"]);
            const writtenSQL = mockSSHStream.write.mock.calls[0][0];
            expect(writtenSQL).toContain(`a = 'O''Reilly'`);
        });
    });

    // ... (Export and Schema Modifications tests remain the same) ...
    describe('Export Functionality', () => {
        beforeEach(() => {
            adapter = new SQLiteAdapter(createConfig(false));
        });

        test('exportTable should handle Uint8Array/Buffer correctly', async () => {
            mockStmt.step
                .mockReturnValueOnce(true) 
                .mockReturnValueOnce(false) 
                .mockReturnValueOnce(true) 
                .mockReturnValueOnce(false); 

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
            mockStmt.step.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
            mockStmt.getAsObject
                .mockReturnValueOnce({ name: 'id', type: 'INTEGER', pk: 1, notnull: 0 })
                .mockReturnValueOnce({ name: 'old', type: 'TEXT', pk: 0, notnull: 0 });

            await adapter.modifyColumn('main', 'users', 'old', 'new', 'INTEGER', ['NOT NULL']);
            const writeCalls = mockDbInstance.run.mock.calls.map((c: any) => c[0]);
            
            expect(writeCalls).toEqual(expect.arrayContaining([
                'BEGIN TRANSACTION',
                expect.stringContaining('RENAME TO'),
                expect.stringContaining('CREATE TABLE'),
                expect.stringContaining('INSERT INTO'),
                expect.stringContaining('DROP TABLE'),
                'COMMIT'
            ]));
            expect(fs.writeFileSync).toHaveBeenCalled();
        });

        test('modifyColumn should ROLLBACK on error', async () => {
            mockStmt.step.mockReturnValueOnce(false); 
            mockDbInstance.run.mockImplementation((sql: string) => {
                if (sql.includes('RENAME TO')) {
                    throw new Error('Disk full');
                }
            });

            await expect(adapter.modifyColumn('main', 't', 'c', 'c', 'INT', [])).rejects.toThrow('Disk full');
            expect(mockDbInstance.run).toHaveBeenCalledWith('ROLLBACK', expect.anything());
        });
    });
});