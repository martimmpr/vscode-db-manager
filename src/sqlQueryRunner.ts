import * as vscode from 'vscode';
import { Connection } from './types';
import { DatabaseAdapterFactory } from './database';

export class SqlQueryRunner {
    private activeConnection: Connection | undefined;
    private activeDatabase: string | undefined;
    private statusBarItem: vscode.StatusBarItem;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'sqlQueryRunner.selectConnection';
        
        context.subscriptions.push(this.statusBarItem);
        
        vscode.window.onDidChangeActiveTextEditor(editor => {
            this.updateStatusBar(editor);
        });
        
        this.updateStatusBar(vscode.window.activeTextEditor);
    }

    private updateStatusBar(editor: vscode.TextEditor | undefined) {
        if (editor && editor.document.languageId === 'sql') {
            this.statusBarItem.show();
            this.updateStatusBarText();
        } else {
            this.statusBarItem.hide();
        }
    }

    private updateStatusBarText() {
        if (this.activeConnection) {
            let text = `$(database) ${this.activeConnection.name}`;
            if (this.activeDatabase) {
                text += ` • ${this.activeDatabase}`;
            }
            this.statusBarItem.text = text;
            this.statusBarItem.tooltip = `Connected to ${this.activeConnection.name} (${this.activeConnection.type})`;
        } else {
            this.statusBarItem.text = "$(database) No connection";
            this.statusBarItem.tooltip = "Click to select a database connection";
        }
    }

    async selectConnection() {
        const connections = this.context.globalState.get<Connection[]>('connections', []);
        
        if (connections.length === 0) {
            vscode.window.showWarningMessage('No database connections available. Please add a connection first.');
            return;
        }

        const items = connections.map(conn => ({
            label: conn.name,
            description: `${conn.type} - ${conn.host}:${conn.port}`,
            connection: conn
        }));

        // Add option to disconnect only if there's an active connection
        if (this.activeConnection) {
            items.unshift({
                label: '$(close) No connection',
                description: 'Disconnect from current connection',
                connection: undefined as any
            });
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a database connection'
        });

        if (selected) {
            if (selected.label.startsWith('$(close)')) {
                this.activeConnection = undefined;
                this.activeDatabase = undefined;
                this.updateStatusBarText();
            } else {
                this.activeConnection = selected.connection;
                this.activeDatabase = undefined; // Reset database when changing connection
                this.updateStatusBarText();
                
                // Optionally select database
                await this.selectDatabase();
            }
        }
    }

    async selectDatabase() {
        if (!this.activeConnection) {
            vscode.window.showWarningMessage('Please select a connection first.');
            return;
        }

        const adapter = DatabaseAdapterFactory.createAdapter(this.activeConnection);
        
        try {
            const databases = await adapter.getDatabases();
            await adapter.close();

            if (databases.length === 0) {
                vscode.window.showInformationMessage('No databases found!');
                return;
            }

            const items = databases.map(db => ({
                label: db,
                description: 'Database'
            }));

            // Add option to not select a database
            items.unshift({
                label: '$(close) No database',
                description: 'Execute queries without a default database'
            });

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a database (optional)'
            });

            if (selected) {
                if (selected.label.startsWith('$(close)')) {
                    this.activeDatabase = undefined;
                } else {
                    this.activeDatabase = selected.label;
                }
                this.updateStatusBarText();
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to load databases: ${errorMessage}.`);
        }
    }

    async executeQuery() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'sql') {
            vscode.window.showWarningMessage('Please open a SQL file first.');
            return;
        }

        if (!this.activeConnection) {
            const answer = await vscode.window.showWarningMessage(
                'No connection selected. Would you like to select one?',
                'Select Connection',
                'Cancel'
            );
            if (answer === 'Select Connection') {
                await this.selectConnection();
                if (!this.activeConnection) {
                    return;
                }
            } else {
                return;
            }
        }

        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showWarningMessage('Please select SQL code to execute.');
            return;
        }

        const query = editor.document.getText(selection);
        
        // Check if query is USE DATABASE command
        const useDbMatch = query.trim().match(/^USE\s+(?:DATABASE\s+)?([`"]?)(\w+)\1\s*;?\s*$/i);
        if (useDbMatch) {
            this.activeDatabase = useDbMatch[2];
            this.updateStatusBarText();
            vscode.window.showInformationMessage(`Switched to database: ${this.activeDatabase}`);
            return;
        }

        await this.runQuery(query);
    }

    async executeCurrentLine() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'sql') {
            vscode.window.showWarningMessage('Please open a SQL file first.');
            return;
        }

        if (!this.activeConnection) {
            const answer = await vscode.window.showWarningMessage(
                'No connection selected. Would you like to select one?',
                'Select Connection',
                'Cancel'
            );
            if (answer === 'Select Connection') {
                await this.selectConnection();
                if (!this.activeConnection) {
                    return;
                }
            } else {
                return;
            }
        }

        let query: string;
        const selection = editor.selection;

        // If there's a selection, use it; otherwise, use the current line
        if (!selection.isEmpty) {
            query = editor.document.getText(selection);
        } else {
            const currentLine = editor.document.lineAt(editor.selection.active.line);
            query = currentLine.text.trim();
            
            if (!query) {
                vscode.window.showWarningMessage('Current line is empty.');
                return;
            }
        }

        // Check if query is USE DATABASE command
        const useDbMatch = query.trim().match(/^USE\s+(?:DATABASE\s+)?([`"]?)(\w+)\1\s*;?\s*$/i);
        if (useDbMatch) {
            this.activeDatabase = useDbMatch[2];
            this.updateStatusBarText();
            vscode.window.showInformationMessage(`Switched to database: ${this.activeDatabase}`);
            return;
        }

        await this.runQuery(query);
    }

    private async runQuery(query: string) {
        if (!this.activeConnection) {
            return;
        }

        const adapter = DatabaseAdapterFactory.createAdapter(this.activeConnection);

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Executing SQL query...',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Running query...' });
                
                const result = await adapter.executeQuery(query, this.activeDatabase);
                await adapter.close();

                if (result && result.rows && result.rows.length > 0) {
                    // Show results in output channel
                    const outputChannel = vscode.window.createOutputChannel('SQL Results');
                    outputChannel.clear();
                    outputChannel.appendLine('Query executed successfully!');
                    outputChannel.appendLine(`Rows returned: ${result.rows.length}`);
                    outputChannel.appendLine('');
                    
                    if (result.fields && result.fields.length > 0) {
                        const headers = result.fields.map((f: { name: string }) => f.name);
                        outputChannel.appendLine(headers.join(' | '));
                        outputChannel.appendLine(headers.map((h: string) => '-'.repeat(h.length)).join('-+-'));
                        
                        result.rows.forEach((row: any) => {
                            const values = headers.map((h: string) => {
                                const value = row[h];
                                return value !== null && value !== undefined ? String(value) : 'NULL';
                            });
                            outputChannel.appendLine(values.join(' | '));
                        });
                    }
                    
                    outputChannel.show();
                    vscode.window.showInformationMessage(`Query executed successfully! ${result.rows.length} row(s) returned.`);
                } else if (result && result.affectedRows !== undefined) {
                    vscode.window.showInformationMessage(`Query executed successfully! ${result.affectedRows} row(s) affected.`);
                } else {
                    vscode.window.showInformationMessage('Query executed successfully!');
                }
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Query execution failed: ${errorMessage}.`);
        }
    }

    getActiveConnection(): Connection | undefined {
        return this.activeConnection;
    }

    getActiveDatabase(): string | undefined {
        return this.activeDatabase;
    }

    setActiveConnection(connection: Connection, database?: string) {
        this.activeConnection = connection;
        this.activeDatabase = database;
        this.updateStatusBarText();
    }
}