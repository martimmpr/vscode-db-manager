import * as vscode from 'vscode';
import * as path from 'path';

export type DatabaseType = 'PostgreSQL' | 'MySQL' | 'MariaDB' | 'SQLite';

export interface SSHConfig {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKeyPath?: string;
    passphrase?: string; 
}

export interface SQLiteConnectionParams {
    filePath: string;       
    useSSH: boolean;        
    sshConfig?: SSHConfig;
}

export interface Connection {
    name: string;
    type: DatabaseType;
    host: string;
    port: number;
    username: string;
    password: string;
    database?: string;
    selectedDatabases?: string[];
    selectedTables?: { [database: string]: string[] };
    sqlite?: SQLiteConnectionParams;
}

export class DatabaseItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'connection' | 'database' | 'table' | 'empty',
        public readonly connection?: Connection,
        public readonly database?: string,
        public readonly table?: string,
        extensionPath?: string
    ) {
        super(label, collapsibleState);

        this.contextValue = type;
        
        switch (type) {
            case 'connection':
                if (connection && extensionPath) {
                    const iconFolder = path.join(extensionPath, 'src', 'icons');
                    
                    switch (connection.type) {
                        case 'PostgreSQL':
                            this.iconPath = path.join(iconFolder, 'postgresql.svg');
                            break;
                        case 'MySQL':
                            this.iconPath = path.join(iconFolder, 'mysql.svg');
                            break;
                        case 'MariaDB':
                            this.iconPath = path.join(iconFolder, 'mariadb.svg');
                            break;
                        case 'SQLite':
                            this.iconPath = path.join(iconFolder, 'sqlite.svg');
                            break;
                        default:
                            this.iconPath = new vscode.ThemeIcon('database');
                            break;
                    }
                } else {
                    this.iconPath = new vscode.ThemeIcon('database');
                }
                break;
            case 'database':
                this.iconPath = new vscode.ThemeIcon('library');
                break;
            case 'table':
                this.iconPath = new vscode.ThemeIcon('window');
                break;
            case 'empty':
                this.iconPath = new vscode.ThemeIcon('info');
                this.contextValue = 'empty';
                break;
        }
    }
}