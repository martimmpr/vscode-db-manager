jest.mock('pg');

import { PostgreSQLAdapter } from '../PostgreSQLAdapter';
import { Connection } from '../../types';
import { Client } from 'pg';

describe('PostgreSQLAdapter', () => {
    let adapter: PostgreSQLAdapter;
    let mockClient: any;
    let mockQuery: jest.Mock;
    let mockConnect: jest.Mock;
    let mockEnd: jest.Mock;

    const createConfig = (database?: string): Connection => ({
        name: 'Test PostgreSQL',
        type: 'PostgreSQL',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'password',
        database: database
    });

    beforeEach(() => {
        jest.clearAllMocks();

        mockQuery = jest.fn();
        mockConnect = jest.fn().mockResolvedValue(undefined);
        mockEnd = jest.fn().mockResolvedValue(undefined);

        mockClient = {
            query: mockQuery,
            connect: mockConnect,
            end: mockEnd
        };

        (Client as unknown as jest.Mock).mockImplementation(() => mockClient);
    });

    afterEach(async () => {
        if (adapter) {
            await adapter.close();
        }
    });

    describe('Initialization', () => {
        test('should initialize with default database', () => {
            adapter = new PostgreSQLAdapter(createConfig());
            expect(adapter).toBeInstanceOf(PostgreSQLAdapter);
        });

        test('should initialize with custom database', () => {
            adapter = new PostgreSQLAdapter(createConfig('mydb'));
            expect(adapter).toBeInstanceOf(PostgreSQLAdapter);
        });

        test('should create client with correct configuration', async () => {
            adapter = new PostgreSQLAdapter(createConfig('testdb'));
            mockQuery.mockResolvedValue({ rows: [] });
            
            await adapter.testConnection();

            expect(Client).toHaveBeenCalledWith({
                host: 'localhost',
                port: 5432,
                user: 'postgres',
                password: 'password',
                database: 'testdb'
            });
        });
    });

    describe('Connection Management', () => {
        beforeEach(() => {
            adapter = new PostgreSQLAdapter(createConfig());
        });

        test('testConnection should execute SELECT 1', async () => {
            mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });
            
            await adapter.testConnection();
            
            expect(mockConnect).toHaveBeenCalledTimes(1);
            expect(mockQuery).toHaveBeenCalledWith('SELECT 1');
        });

        test('should reuse existing client for same database', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            
            await adapter.testConnection();
            await adapter.getDatabases();
            
            expect(mockConnect).toHaveBeenCalledTimes(1);
        });

        test('should create new client when switching database', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            
            await adapter.testConnection();
            await adapter.getTables('otherdb');
            
            expect(mockConnect).toHaveBeenCalledTimes(2);
            expect(mockEnd).toHaveBeenCalledTimes(1);
        });

        test('should handle connection errors', async () => {
            mockConnect.mockRejectedValue(new Error('Connection refused'));
            
            await expect(adapter.testConnection()).rejects.toThrow('Connection refused');
        });
    });

    describe('Database Operations', () => {
        beforeEach(() => {
            adapter = new PostgreSQLAdapter(createConfig());
        });

        test('getDatabases should return list of databases', async () => {
            mockQuery.mockResolvedValue({
                rows: [
                    { datname: 'postgres' },
                    { datname: 'mydb' },
                    { datname: 'testdb' }
                ]
            });
            
            const databases = await adapter.getDatabases();
            
            expect(databases).toEqual(['postgres', 'mydb', 'testdb']);
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('pg_database')
            );
        });

        test('getTables should return list of tables', async () => {
            mockQuery.mockResolvedValue({
                rows: [
                    { table_name: 'users' },
                    { table_name: 'products' },
                    { table_name: 'orders' }
                ]
            });
            
            const tables = await adapter.getTables('mydb');
            
            expect(tables).toEqual(['users', 'products', 'orders']);
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('information_schema.tables')
            );
        });

        test('getColumns should return column information', async () => {
            mockQuery.mockResolvedValue({
                rows: [
                    { 
                        column_name: 'id', 
                        data_type: 'integer', 
                        is_nullable: 'NO',
                        column_default: 'nextval(\'users_id_seq\'::regclass)'
                    },
                    { 
                        column_name: 'name', 
                        data_type: 'character varying', 
                        is_nullable: 'YES',
                        column_default: null
                    }
                ]
            });
            
            const columns = await adapter.getColumns('mydb', 'users');
            
            expect(columns).toHaveLength(2);
            expect(columns[0].column_name).toBe('id');
            expect(columns[0].data_type).toBe('integer');
            expect(columns[0].is_nullable).toBe('NO');
        });
    });

    describe('Table Operations', () => {
        beforeEach(() => {
            adapter = new PostgreSQLAdapter(createConfig());
        });

        test('createTable should generate correct SQL', async () => {
            mockQuery.mockResolvedValue({});
            
            await adapter.createTable('mydb', 'users', [
                { name: 'id', type: 'INTEGER', constraints: ['PRIMARY KEY', 'GENERATED ALWAYS AS IDENTITY'] },
                { name: 'name', type: 'VARCHAR(100)', constraints: ['NOT NULL'] },
                { name: 'email', type: 'VARCHAR(255)', constraints: ['UNIQUE'] }
            ]);
            
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('CREATE TABLE IF NOT EXISTS "users"')
            );
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('"id" INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY')
            );
        });

        test('deleteTable should drop table', async () => {
            mockQuery.mockResolvedValue({});
            
            await adapter.deleteTable('mydb', 'users');
            
            expect(mockQuery).toHaveBeenCalledWith('DROP TABLE "users"');
        });

        test('renameTable should rename table', async () => {
            mockQuery.mockResolvedValue({});
            
            await adapter.renameTable('mydb', 'users', 'customers');
            
            expect(mockQuery).toHaveBeenCalledWith('ALTER TABLE "users" RENAME TO "customers"');
        });
    });

    describe('Column Operations', () => {
        beforeEach(() => {
            adapter = new PostgreSQLAdapter(createConfig());
        });

        test('addColumn should add new column with constraints', async () => {
            mockQuery.mockResolvedValue({});
            
            await adapter.addColumn('mydb', 'users', 'age', 'INTEGER', ['NOT NULL'], '0');
            
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('ALTER TABLE "users" ADD COLUMN "age" INTEGER DEFAULT 0 NOT NULL')
            );
        });

        test('addColumn should handle string default values', async () => {
            mockQuery.mockResolvedValue({});
            
            await adapter.addColumn('mydb', 'users', 'status', 'VARCHAR(20)', ['NOT NULL'], 'active');
            
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining("DEFAULT 'active'")
            );
        });

        test('addColumn should handle special keywords', async () => {
            mockQuery.mockResolvedValue({});
            
            await adapter.addColumn('mydb', 'users', 'created_at', 'TIMESTAMP', [], 'CURRENT_TIMESTAMP');
            
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('DEFAULT CURRENT_TIMESTAMP')
            );
        });

        test('addColumn should escape single quotes in default values', async () => {
            mockQuery.mockResolvedValue({});
            
            await adapter.addColumn('mydb', 'users', 'bio', 'TEXT', [], "O'Reilly");
            
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining("DEFAULT 'O''Reilly'")
            );
        });

        test('removeColumn should drop column', async () => {
            mockQuery.mockResolvedValue({});
            
            await adapter.removeColumn('mydb', 'users', 'age');
            
            expect(mockQuery).toHaveBeenCalledWith('ALTER TABLE "users" DROP COLUMN "age"');
        });

        test('modifyColumn should handle complex modifications', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            
            await adapter.modifyColumn('mydb', 'users', 'age', 'age', 'BIGINT', ['NOT NULL'], '18');
            
            expect(mockQuery).toHaveBeenCalled();
        });
    });

    describe('Query Operations', () => {
        beforeEach(() => {
            adapter = new PostgreSQLAdapter(createConfig());
        });

        test('query should execute SELECT and return results', async () => {
            mockQuery.mockResolvedValue({
                rows: [
                    { id: 1, name: 'John' },
                    { id: 2, name: 'Jane' }
                ],
                rowCount: 2,
                fields: [
                    { name: 'id', dataTypeID: 23 },
                    { name: 'name', dataTypeID: 1043 }
                ]
            });
            
            const result = await adapter.query('mydb', 'SELECT * FROM users');
            
            expect(result.rows).toHaveLength(2);
            expect(result.rowCount).toBe(2);
            expect(result.fields).toBeDefined();
            expect(result.fields[0].name).toBe('id');
            expect(result.fields[1].name).toBe('name');
        });

        test('query should handle parameterized queries', async () => {
            mockQuery.mockResolvedValue({ rows: [], rowCount: 0, fields: [] });
            
            await adapter.query('mydb', 'SELECT * FROM users WHERE id = $1', [1]);
            
            expect(mockQuery).toHaveBeenCalledWith(
                'SELECT * FROM users WHERE id = $1',
                [1]
            );
        });

        test('query should handle INSERT operations', async () => {
            mockQuery.mockResolvedValue({
                rows: [],
                rowCount: 1,
                fields: []
            });
            
            const result = await adapter.query('mydb', 'INSERT INTO users (name) VALUES ($1)', ['John']);
            
            expect(result.rowCount).toBe(1);
        });

        test('query should handle errors', async () => {
            mockQuery.mockRejectedValue(new Error('Syntax error'));
            
            await expect(adapter.query('mydb', 'INVALID SQL')).rejects.toThrow('Syntax error');
        });
    });

    describe('Data Export', () => {
        beforeEach(() => {
            adapter = new PostgreSQLAdapter(createConfig());
        });

        test('exportTable should generate SQL with CREATE and INSERT', async () => {
            mockQuery
                .mockResolvedValueOnce({
                    rows: [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null }]
                })
                .mockResolvedValueOnce({
                    rows: [{ attname: 'id' }]
                })
                .mockResolvedValueOnce({
                    rows: [
                        { id: 1, name: 'John' },
                        { id: 2, name: 'Jane' }
                    ]
                });
            
            const sql = await adapter.exportTable('mydb', 'users', true);
            
            expect(sql).toContain('CREATE TABLE');
            expect(sql).toContain('INSERT INTO');
            expect(sql).toContain('John');
            expect(sql).toContain('Jane');
        });

        test('exportTable should handle NULL values', async () => {
            mockQuery
                .mockResolvedValueOnce({
                    rows: [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null }]
                })
                .mockResolvedValueOnce({
                    rows: [{ attname: 'id' }]
                })
                .mockResolvedValueOnce({
                    rows: [{ id: 1, email: null }]
                });
            
            const sql = await adapter.exportTable('mydb', 'users', true);
            
            expect(sql).toContain('NULL');
        });
    });

    describe('Constraints and Keys', () => {
        beforeEach(() => {
            adapter = new PostgreSQLAdapter(createConfig());
        });

        test('getPrimaryKeys should return primary key columns', async () => {
            mockQuery.mockResolvedValue({
                rows: [{ attname: 'id' }]
            });
            
            const pk = await adapter.getPrimaryKeys('mydb', 'users');
            
            expect(pk).toEqual(['id']);
        });

        test('getUniqueKeys should return unique constraint columns', async () => {
            mockQuery.mockResolvedValue({
                rows: [{ attname: 'email' }]
            });
            
            const unique = await adapter.getUniqueKeys('mydb', 'users');
            
            expect(unique).toEqual(['email']);
        });
    });

    describe('Close Connection', () => {
        beforeEach(() => {
            adapter = new PostgreSQLAdapter(createConfig());
        });

        test('close should end client connection', async () => {
            mockQuery.mockResolvedValue({});
            await adapter.testConnection();
            
            await adapter.close();
            
            expect(mockEnd).toHaveBeenCalled();
        });

        test('close should handle already closed connection', async () => {
            await adapter.close();
            
            expect(mockEnd).not.toHaveBeenCalled();
        });

        test('close should ignore errors', async () => {
            mockQuery.mockResolvedValue({});
            await adapter.testConnection();
            mockEnd.mockRejectedValue(new Error('Already closed'));
            
            await expect(adapter.close()).resolves.not.toThrow();
        });
    });
});