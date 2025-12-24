import { Connection } from '../types';
import { IDatabaseAdapter } from './IDatabaseAdapter';
import { PostgreSQLAdapter } from './PostgreSQLAdapter';
import { MySQLAdapter } from './MySQLAdapter';
import { MariaDBAdapter } from './MariaDBAdapter';

export class DatabaseDetector {
    // Attempts to detect the database type by connecting and querying version information
    static async detectDatabaseType(
        host: string,
        port: number,
        username: string,
        password: string
    ): Promise<'PostgreSQL' | 'MySQL' | 'MariaDB' | null> {
        // Try PostgreSQL first
        try {
            const pgConnection: Connection = {
                name: 'temp',
                type: 'PostgreSQL',
                host,
                port,
                username,
                password
            };
            const pgAdapter = new PostgreSQLAdapter(pgConnection);
            await pgAdapter.testConnection();
            await pgAdapter.close();
            return 'PostgreSQL';
        } catch (error) {
            // PostgreSQL failed, continue
        }

        // Try MySQL/MariaDB
        try {
            const mysqlConnection: Connection = {
                name: 'temp',
                type: 'MySQL',
                host,
                port,
                username,
                password
            };
            const mysqlAdapter = new MySQLAdapter(mysqlConnection);
            await mysqlAdapter.testConnection();
            
            // Try to detect if it's MariaDB by checking version
            try {
                const versionResult = await mysqlAdapter.query('', 'SELECT VERSION() as version', []);
                const version = versionResult[0]?.version?.toLowerCase() || '';
                
                await mysqlAdapter.close();
                
                if (version.includes('mariadb')) {
                    return 'MariaDB';
                } else {
                    return 'MySQL';
                }
            } catch (error) {
                await mysqlAdapter.close();
                // If version check fails, default to MySQL
                return 'MySQL';
            }
        } catch (error) {
            // MySQL/MariaDB also failed
        }

        return null; // Could not detect
    }
}