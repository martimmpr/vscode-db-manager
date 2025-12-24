export interface ColumnDefinition {
    name: string;
    type: string;
    constraints: string[];
}

export interface ColumnInfo {
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default?: string;
    character_maximum_length?: number;
    numeric_precision?: number;
    numeric_scale?: number;
}

export interface QueryResult {
    rows: any[];
    fields?: Array<{ name: string }>;
    affectedRows?: number;
}

export interface IDatabaseAdapter {
    // Test the connection to the database
    testConnection(): Promise<void>;

    // Get list of all databases
    getDatabases(): Promise<string[]>;

    // Get list of all tables in a database
    getTables(database: string): Promise<string[]>;

    // Create a new table
    createTable(database: string, tableName: string, columns: ColumnDefinition[]): Promise<void>;

    // Delete a table
    deleteTable(database: string, tableName: string): Promise<void>;

    // Rename a table
    renameTable(database: string, oldTableName: string, newTableName: string): Promise<void>;

    // Add a column to a table
    addColumn(database: string, tableName: string, columnName: string, columnType: string, constraints: string[]): Promise<void>;

    // Remove a column from a table
    removeColumn(database: string, tableName: string, columnName: string): Promise<void>;

    // Get all columns from a table with their information
    getColumns(database: string, tableName: string): Promise<ColumnInfo[]>;

    // Get primary keys for a table
    getPrimaryKeys(database: string, tableName: string): Promise<string[]>;

    // Get unique keys for a table
    getUniqueKeys(database: string, tableName: string): Promise<string[]>;

    // Execute a raw query
    query(database: string, query: string, params?: any[]): Promise<any>;

    // Execute a query and return formatted results
    executeQuery(query: string, database?: string): Promise<QueryResult>;

    // Export database structure and data
    exportDatabase(database: string, includeData: boolean): Promise<string>;

    // Export table structure and data
    exportTable(database: string, tableName: string, includeData: boolean): Promise<string>;

    // Close the connection
    close(): Promise<void>;
}