import { MySQLAdapter } from './MySQLAdapter';
import { Connection } from '../types';

/**
 * MariaDB uses the same protocol as MySQL, so we can extend MySQLAdapter
 * If in the future there are MariaDB-specific features needed, they can be added here
 */
export class MariaDBAdapter extends MySQLAdapter {
    constructor(connection: Connection) {
        super(connection);
    }
}