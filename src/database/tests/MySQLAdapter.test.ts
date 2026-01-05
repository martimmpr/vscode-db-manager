jest.mock('mysql2/promise');

import { MySQLAdapter } from '../MySQLAdapter';
import { Connection } from '../../types';
import * as mysql from 'mysql2/promise';

describe('MySQLAdapter', () => {
    let adapter: MySQLAdapter;
    let mockConnection: any;
    let mockQuery: jest.Mock;
    let mockEnd: jest.Mock;

    const createConfig = (database?: string): Connection => ({
        name: 'Test MySQL',
        type: 'MySQL',
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'password',
        database: database
    });

    beforeEach(() => {
        jest.clearAllMocks();

        mockQuery = jest.fn();
        mockEnd = jest.fn().mockResolvedValue(undefined);

        mockConnection = {
            query: mockQuery,
            end: mockEnd
        };

        (mysql.createConnection as jest.Mock).mockResolvedValue(mockConnection);
    });

    afterEach(async () => {
        if (adapter) {
            await adapter.close();
        }
    });

    describe('Initialization', () => {
        test('should initialize without database', () => {
            adapter = new MySQLAdapter(createConfig());
            expect(adapter).toBeInstanceOf(MySQLAdapter);
        });

        test('should initialize with custom database', () => {
            adapter = new MySQLAdapter(createConfig('mydb'));
            expect(adapter).toBeInstanceOf(MySQLAdapter);
        });

        test('should create connection with correct configuration', async () => {
            adapter = new MySQLAdapter(createConfig('testdb'));
            mockQuery.mockResolvedValue([[], []]);
            
            await adapter.testConnection();

            expect(mysql.createConnection).toHaveBeenCalledWith({
                host: 'localhost',
                port: 3306,
                user: 'root',
                password: 'password',
                database: 'testdb'
            });
        });
    });

    describe('Connection Management', () => {
        beforeEach(() => {
            adapter = new MySQLAdapter(createConfig());
        });

        test('testConnection should execute SELECT 1', async () => {
            mockQuery.mockResolvedValue([[], []]);
            
            await adapter.testConnection();
            
            expect(mysql.createConnection).toHaveBeenCalledTimes(1);
            expect(mockQuery).toHaveBeenCalledWith('SELECT 1');
        });

        test('should reuse existing connection for same database', async () => {
            mockQuery.mockResolvedValue([[{ SCHEMA_NAME: 'mydb' }], []]);
            
            await adapter.testConnection();
            await adapter.getDatabases();
            
            expect(mysql.createConnection).toHaveBeenCalledTimes(1);
        });

        test('should create new connection when switching database', async () => {
            mockQuery.mockResolvedValue([[], []]);
            
            await adapter.testConnection();
            await adapter.getTables('otherdb');
            
            expect(mysql.createConnection).toHaveBeenCalledTimes(2);
            expect(mockEnd).toHaveBeenCalledTimes(1);
        });

        test('should handle connection errors', async () => {
            (mysql.createConnection as jest.Mock).mockRejectedValue(new Error('Access denied'));
            
            await expect(adapter.testConnection()).rejects.toThrow('Access denied');
        });
    });

    describe('Database Operations', () => {
        beforeEach(() => {
            adapter = new MySQLAdapter(createConfig());
        });

        test('getDatabases should return list of databases', async () => {
            mockQuery.mockResolvedValue([[
                { SCHEMA_NAME: 'mydb' },
                { SCHEMA_NAME: 'testdb' },
                { SCHEMA_NAME: 'production' }
            ], []]);
            
            const databases = await adapter.getDatabases();
            
            expect(databases).toEqual(['mydb', 'testdb', 'production']);
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('information_schema.schemata')
            );
        });

        test('getDatabases should filter system databases', async () => {
            mockQuery.mockResolvedValue([[
                { SCHEMA_NAME: 'mydb' }
            ], []]);
            
            const databases = await adapter.getDatabases();
            
            expect(databases).not.toContain('information_schema');
            expect(databases).not.toContain('mysql');
            expect(databases).not.toContain('performance_schema');
            expect(databases).not.toContain('sys');
        });

        test('getTables should return list of tables', async () => {
            mockQuery.mockResolvedValue([[
                { TABLE_NAME: 'users' },
                { TABLE_NAME: 'products' },
                { TABLE_NAME: 'orders' }
            ], []]);
            
            const tables = await adapter.getTables('mydb');
            
            expect(tables).toEqual(['users', 'products', 'orders']);
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('information_schema.tables'),
                ['mydb']
            );
        });

        test('getColumns should return column information', async () => {
            mockQuery.mockResolvedValue([[
                { 
                    COLUMN_NAME: 'id', 
                    DATA_TYPE: 'int', 
                    IS_NULLABLE: 'NO',
                    COLUMN_DEFAULT: null,
                    EXTRA: 'auto_increment'
                },
                { 
                    COLUMN_NAME: 'name', 
                    DATA_TYPE: 'varchar', 
                    IS_NULLABLE: 'YES',
                    COLUMN_DEFAULT: null,
                    EXTRA: ''
                }
            ], []]);
            
            const columns = await adapter.getColumns('mydb', 'users');
            
            expect(columns).toHaveLength(2);
            expect(columns[0].column_name).toBe('id');
            expect(columns[0].data_type).toBe('int');
            expect(columns[0].is_nullable).toBe('NO');
        });
    });

    describe('Table Operations', () => {
        beforeEach(() => {
            adapter = new MySQLAdapter(createConfig());
        });

        test('createTable should generate correct SQL', async () => {
            mockQuery.mockResolvedValue([{}, []]);
            
            await adapter.createTable('mydb', 'users', [
                { name: 'id', type: 'INT', constraints: ['PRIMARY KEY', 'GENERATED ALWAYS AS IDENTITY'] },
                { name: 'name', type: 'VARCHAR(100)', constraints: ['NOT NULL'] },
                { name: 'email', type: 'VARCHAR(255)', constraints: ['UNIQUE'] }
            ]);
            
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('CREATE TABLE IF NOT EXISTS `users`')
            );
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('AUTO_INCREMENT')
            );
        });

        test('createTable should handle TEXT columns with PRIMARY KEY', async () => {
            mockQuery.mockResolvedValue([{}, []]);
            
            await adapter.createTable('mydb', 'logs', [
                { name: 'id', type: 'TEXT', constraints: ['PRIMARY KEY'] },
                { name: 'message', type: 'TEXT', constraints: [] }
            ]);
            
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('`id`(255)')
            );
        });

        test('deleteTable should drop table', async () => {
            mockQuery.mockResolvedValue([{}, []]);
            
            await adapter.deleteTable('mydb', 'users');
            
            expect(mockQuery).toHaveBeenCalledWith('DROP TABLE `users`');
        });

        test('renameTable should rename table', async () => {
            mockQuery.mockResolvedValue([{}, []]);
            
            await adapter.renameTable('mydb', 'users', 'customers');
            
            expect(mockQuery).toHaveBeenCalledWith('RENAME TABLE `users` TO `customers`');
        });
    });

    describe('Column Operations', () => {
        beforeEach(() => {
            adapter = new MySQLAdapter(createConfig());
        });

        test('addColumn should add new column with constraints', async () => {
            mockQuery.mockResolvedValue([{}, []]);
            
            await adapter.addColumn('mydb', 'users', 'age', 'INT', ['NOT NULL'], '0');
            
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('ALTER TABLE `users` ADD COLUMN `age` INT DEFAULT 0 NOT NULL')
            );
        });

        test('addColumn should handle string default values', async () => {
            mockQuery.mockResolvedValue([{}, []]);
            
            await adapter.addColumn('mydb', 'users', 'status', 'VARCHAR(20)', ['NOT NULL'], 'active');
            
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining("DEFAULT 'active'")
            );
        });

        test('addColumn should handle CURRENT_TIMESTAMP', async () => {
            mockQuery.mockResolvedValue([{}, []]);
            
            await adapter.addColumn('mydb', 'users', 'created_at', 'TIMESTAMP', [], 'CURRENT_TIMESTAMP');
            
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('DEFAULT CURRENT_TIMESTAMP')
            );
        });

        test('addColumn should escape single quotes', async () => {
            mockQuery.mockResolvedValue([{}, []]);
            
            await adapter.addColumn('mydb', 'users', 'bio', 'TEXT', [], "O'Reilly");
            
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining("DEFAULT 'O''Reilly'")
            );
        });

        test('removeColumn should drop column', async () => {
            mockQuery.mockResolvedValue([{}, []]);
            
            await adapter.removeColumn('mydb', 'users', 'age');
            
            expect(mockQuery).toHaveBeenCalledWith('ALTER TABLE `users` DROP COLUMN `age`');
        });

        test('modifyColumn should handle type changes', async () => {
            mockQuery.mockResolvedValue([[
                { COLUMN_NAME: 'id' },
                { COLUMN_NAME: 'age' }
            ], []]);
            
            await adapter.modifyColumn('mydb', 'users', 'age', 'age', 'BIGINT', ['NOT NULL'], '0');
            
            expect(mockQuery).toHaveBeenCalled();
        });
    });

    describe('Query Operations', () => {
        beforeEach(() => {
            adapter = new MySQLAdapter(createConfig());
        });

        test('query should execute SELECT and return results', async () => {
            const mockFields = [
                { name: 'id', type: 3 },
                { name: 'name', type: 253 }
            ];
            
            mockQuery.mockResolvedValue([
                [
                    { id: 1, name: 'John' },
                    { id: 2, name: 'Jane' }
                ],
                mockFields
            ]);
            
            const result = await adapter.query('mydb', 'SELECT * FROM users');
            
            expect(result).toHaveLength(2);
            expect(result[0].id).toBe(1);
            expect(result[0].name).toBe('John');
        });

        test('query should handle parameterized queries', async () => {
            mockQuery.mockResolvedValue([[], []]);
            
            await adapter.query('mydb', 'SELECT * FROM users WHERE id = ?', [1]);
            
            expect(mockQuery).toHaveBeenCalledWith(
                'SELECT * FROM users WHERE id = ?',
                [1]
            );
        });

        test('query should handle INSERT operations', async () => {
            mockQuery.mockResolvedValue([{ affectedRows: 1, insertId: 5 }, []]);
            
            const result = await adapter.query('mydb', 'INSERT INTO users (name) VALUES (?)', ['John']);
            
            expect(result.affectedRows).toBe(1);
        });

        test('query should handle errors', async () => {
            mockQuery.mockRejectedValue(new Error('Table does not exist'));
            
            await expect(adapter.query('mydb', 'SELECT * FROM nonexistent')).rejects.toThrow('Table does not exist');
        });
    });

    describe('Data Export', () => {
        beforeEach(() => {
            adapter = new MySQLAdapter(createConfig());
        });

        test('exportTable should generate SQL with CREATE and INSERT', async () => {
            mockQuery
                .mockResolvedValueOnce([[{ column_name: 'id', data_type: 'int', is_nullable: 'NO', column_default: null }], []])
                .mockResolvedValueOnce([[{ COLUMN_NAME: 'id' }], []])
                .mockResolvedValueOnce([
                    [
                        { id: 1, name: 'John' },
                        { id: 2, name: 'Jane' }
                    ],
                    []
                ]);
            
            const sql = await adapter.exportTable('mydb', 'users', true);
            
            expect(sql).toContain('CREATE TABLE');
            expect(sql).toContain('INSERT INTO');
            expect(sql).toContain('John');
            expect(sql).toContain('Jane');
        });

        test('exportTable should handle NULL values', async () => {
            mockQuery
                .mockResolvedValueOnce([[{ column_name: 'id', data_type: 'int', is_nullable: 'NO', column_default: null }], []])
                .mockResolvedValueOnce([[{ COLUMN_NAME: 'id' }], []])
                .mockResolvedValueOnce([[{ id: 1, email: null }], []]);
            
            const sql = await adapter.exportTable('mydb', 'users', true);
            
            expect(sql).toContain('NULL');
        });

        test('exportTable should escape quotes in strings', async () => {
            mockQuery
                .mockResolvedValueOnce([[{ column_name: 'id', data_type: 'int', is_nullable: 'NO', column_default: null }], []])
                .mockResolvedValueOnce([[{ COLUMN_NAME: 'id' }], []])
                .mockResolvedValueOnce([[{ id: 1, name: "O'Reilly" }], []]);
            
            const sql = await adapter.exportTable('mydb', 'users', true);
            
            expect(sql).toContain("O\\'Reilly");
        });
    });

    describe('Constraints and Keys', () => {
        beforeEach(() => {
            adapter = new MySQLAdapter(createConfig());
        });

        test('getPrimaryKeys should return primary key columns', async () => {
            mockQuery.mockResolvedValue([[
                { COLUMN_NAME: 'id' }
            ], []]);
            
            const pk = await adapter.getPrimaryKeys('mydb', 'users');
            
            expect(pk).toEqual(['id']);
        });

        test('getUniqueKeys should return unique constraint columns', async () => {
            mockQuery.mockResolvedValue([[
                { COLUMN_NAME: 'email' }
            ], []]);
            
            const unique = await adapter.getUniqueKeys('mydb', 'users');
            
            expect(unique).toEqual(['email']);
        });
    });

    describe('Close Connection', () => {
        beforeEach(() => {
            adapter = new MySQLAdapter(createConfig());
        });

        test('close should end connection', async () => {
            mockQuery.mockResolvedValue([{}, []]);
            await adapter.testConnection();
            
            await adapter.close();
            
            expect(mockEnd).toHaveBeenCalled();
        });

        test('close should handle already closed connection', async () => {
            await adapter.close();
            
            expect(mockEnd).not.toHaveBeenCalled();
        });

        test('close should ignore errors', async () => {
            mockQuery.mockResolvedValue([{}, []]);
            await adapter.testConnection();
            mockEnd.mockRejectedValue(new Error('Already closed'));
            
            await expect(adapter.close()).resolves.not.toThrow();
        });
    });
});