import * as vscode from 'vscode';
import * as path from 'path';

export type DatabaseType = 'PostgreSQL' | 'MySQL' | 'MariaDB';

export interface Connection {
    name: string;
    type: DatabaseType;
    host: string;
    port: number;
    username: string;
    password: string;
    selectedDatabases?: string[];
    selectedTables?: { [database: string]: string[] };
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
                // Set icon based on database type using custom SVG logos
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