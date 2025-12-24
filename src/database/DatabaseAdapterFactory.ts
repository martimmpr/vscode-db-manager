import { Connection, DatabaseType } from '../types';
import { IDatabaseAdapter } from './IDatabaseAdapter';
import { PostgreSQLAdapter } from './PostgreSQLAdapter';
import { MySQLAdapter } from './MySQLAdapter';
import { MariaDBAdapter } from './MariaDBAdapter';

export class DatabaseAdapterFactory {
    static createAdapter(connection: Connection): IDatabaseAdapter {
        switch (connection.type) {
            case 'PostgreSQL':
                return new PostgreSQLAdapter(connection);
            case 'MySQL':
                return new MySQLAdapter(connection);
            case 'MariaDB':
                return new MariaDBAdapter(connection);
            default:
                throw new Error(`Unsupported database type: ${connection.type}`);
        }
    }
}