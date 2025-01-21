import * as vscode from 'vscode';

export interface Connection {
    name: string;
    host: string;
    port: number;
    username: string;
    password: string;
    selectedDatabases?: string[];
}

export class DatabaseItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'connection' | 'database' | 'table',
        public readonly connection?: Connection,
        public readonly database?: string,
        public readonly table?: string
    ) {
        super(label, collapsibleState);

        this.contextValue = type;
        
        switch (type) {
            case 'connection':
                this.iconPath = new vscode.ThemeIcon('database');
                break;
            case 'database':
                this.iconPath = new vscode.ThemeIcon('library');
                break;
            case 'table':
                this.iconPath = new vscode.ThemeIcon('window');
                break;
        }
    }
}