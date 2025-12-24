import * as vscode from 'vscode';
import { Connection } from './types';
import { DatabaseAdapterFactory } from './database';

export class SQLConsole {
    private panel: vscode.WebviewPanel | undefined;
    private connection: Connection;
    private currentDatabase: string | undefined;

    constructor(connection: Connection) {
        this.connection = connection;
    }

    public show(context: vscode.ExtensionContext) {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'sqlConsole',
            `SQL Console`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = this.getWebviewContent();

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'executeQuery':
                        await this.executeQuery(message.query, message.database);
                        break;
                    case 'getDatabases':
                        await this.getDatabases();
                        break;
                }
            },
            undefined,
            context.subscriptions
        );

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });

        // Load databases on start
        this.getDatabases();
    }

    private async getDatabases() {
        try {
            const adapter = DatabaseAdapterFactory.createAdapter(this.connection);
            const databases = await adapter.getDatabases();
            await adapter.close();

            this.panel?.webview.postMessage({
                command: 'databasesList',
                databases: databases
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.panel?.webview.postMessage({
                command: 'error',
                message: `Failed to load databases: ${errorMessage}`
            });
        }
    }

    private async executeQuery(query: string, database?: string) {
        if (!query.trim()) {
            this.panel?.webview.postMessage({
                command: 'error',
                message: 'Please enter a query!'
            });
            return;
        }

        try {
            const adapter = DatabaseAdapterFactory.createAdapter(this.connection);
            
            // Use the selected database or current database
            const dbToUse = database || this.currentDatabase;
            
            if (!dbToUse) {
                await adapter.close();
                this.panel?.webview.postMessage({
                    command: 'error',
                    message: 'Please select a database first!'
                });
                return;
            }

            this.currentDatabase = dbToUse;

            const result = await adapter.query(dbToUse, query);
            await adapter.close();

            // Format result
            let formattedResult: any;
            if (result.rows) {
                // PostgreSQL result
                formattedResult = {
                    rows: result.rows,
                    rowCount: result.rowCount,
                    command: result.command
                };
            } else if (Array.isArray(result)) {
                // MySQL result (SELECT)
                formattedResult = {
                    rows: result,
                    rowCount: result.length,
                    command: 'SELECT'
                };
            } else if (result.affectedRows !== undefined) {
                // MySQL result (INSERT/UPDATE/DELETE)
                formattedResult = {
                    rows: [],
                    rowCount: result.affectedRows,
                    command: 'MODIFY'
                };
            } else {
                formattedResult = {
                    rows: [],
                    rowCount: 0,
                    command: 'UNKNOWN'
                };
            }

            this.panel?.webview.postMessage({
                command: 'queryResult',
                result: formattedResult
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.panel?.webview.postMessage({
                command: 'error',
                message: errorMessage
            });
        }
    }

    private getWebviewContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SQL Console</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            user-select: none;
        }
        .header {
            display: flex;
            align-items: flex-end;
            gap: 12px;
            margin-bottom: 25px;
        }
        .header h2 {
            margin: 0;
            font-size: 24px;
            font-weight: 600;
        }
        .connection-info {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            padding-bottom: 2px;
        }
        .database-selector-container {
            margin-bottom: 25px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .database-selector {
            padding: 6px 10px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-size: 13px;
        }
        .database-selector:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .query-container {
            margin-bottom: 15px;
        }
        .query-container > label {
            display: block;
            margin-bottom: 10px;
        }
        textarea {
            width: 100%;
            min-height: 150px;
            padding: 10px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-family: 'Consolas', 'Courier New', monospace;
            font-size: 13px;
            resize: vertical;
            outline: 1px solid var(--vscode-focusBorder);
            box-sizing: border-box;
            user-select: text;
        }
        textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .button-container {
            margin-bottom: 20px;
        }
        button {
            padding: 8px 16px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 13px;
            margin-right: 8px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .clear-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .clear-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .result-container {
            margin-top: 20px;
        }
        .result-info {
            padding: 8px 12px;
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textBlockQuote-border);
            margin-bottom: 10px;
            font-size: 12px;
        }
        .error {
            padding: 12px;
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            border-radius: 2px;
            color: var(--vscode-errorForeground);
            margin-bottom: 10px;
        }
        .success {
            padding: 12px;
            background-color: var(--vscode-terminal-ansiGreen);
            border-radius: 2px;
            margin-bottom: 10px;
            opacity: 0.2;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        th, td {
            padding: 8px 12px;
            text-align: left;
            border: 1px solid var(--vscode-panel-border);
        }
        th {
            background-color: var(--vscode-editor-lineHighlightBackground);
            font-weight: 600;
        }
        tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .no-results {
            padding: 20px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
        .keyboard-hint {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 5px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h2>SQL Console</h2>
        <span class="connection-info">Connected to: <strong>${this.connection.name}</strong> (${this.connection.type})</span>
    </div>

    <div class="database-selector-container">
        <label for="database-select">Database:</label>
        <select id="database-select" class="database-selector">
            <option value="">Select database...</option>
        </select>
    </div>

    <div class="query-container">
        <label for="query-input">SQL Query:</label>
        <textarea id="query-input" placeholder="SELECT * FROM users WHERE id = 1;"></textarea>
        <div class="keyboard-hint">💡 Tip: Press Ctrl+Enter (or Cmd+Enter on Mac) to execute the query.</div>
    </div>

    <div class="button-container">
        <button id="execute-btn">Execute Query</button>
        <button id="clear-btn" class="clear-btn">Clear</button>
    </div>

    <div class="result-container" id="result-container"></div>

    <script>
        const vscode = acquireVsCodeApi();
        const queryInput = document.getElementById('query-input');
        const executeBtn = document.getElementById('execute-btn');
        const clearBtn = document.getElementById('clear-btn');
        const resultContainer = document.getElementById('result-container');
        const databaseSelect = document.getElementById('database-select');

        // Load databases
        vscode.postMessage({ command: 'getDatabases' });

        executeBtn.addEventListener('click', () => {
            const query = queryInput.value;
            const database = databaseSelect.value;
            executeBtn.disabled = true;
            executeBtn.textContent = 'Executing...';
            resultContainer.innerHTML = '<div class="result-info">Executing query...</div>';
            vscode.postMessage({ 
                command: 'executeQuery', 
                query: query,
                database: database || undefined
            });
        });

        clearBtn.addEventListener('click', () => {
            queryInput.value = '';
            resultContainer.innerHTML = '';
        });

        // Keyboard shortcut: Ctrl+Enter or Cmd+Enter
        queryInput.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                executeBtn.click();
            }
        });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            executeBtn.disabled = false;
            executeBtn.textContent = 'Execute Query';

            switch (message.command) {
                case 'databasesList':
                    databaseSelect.innerHTML = '<option value="">Select database...</option>';
                    message.databases.forEach(db => {
                        const option = document.createElement('option');
                        option.value = db;
                        option.textContent = db;
                        databaseSelect.appendChild(option);
                    });
                    break;

                case 'queryResult':
                    displayResult(message.result);
                    break;

                case 'error':
                    resultContainer.innerHTML = \`<div class="error"><strong>Error:</strong> \${message.message}</div>\`;
                    break;
            }
        });

        function displayResult(result) {
            if (!result.rows || result.rows.length === 0) {
                resultContainer.innerHTML = \`
                    <div class="result-info">✓ Query executed successfully. Rows affected: \${result.rowCount || 0}</div>
                    <div class="no-results">No results to display</div>
                \`;
                return;
            }

            const columns = Object.keys(result.rows[0]);
            
            let html = \`<div class="result-info">✓ Query executed successfully. \${result.rows.length} row(s) returned</div>\`;
            html += '<table><thead><tr>';
            
            columns.forEach(col => {
                html += \`<th>\${escapeHtml(col)}</th>\`;
            });
            
            html += '</tr></thead><tbody>';
            
            result.rows.forEach(row => {
                html += '<tr>';
                columns.forEach(col => {
                    const value = row[col];
                    let displayValue = value === null ? '<em>NULL</em>' : escapeHtml(String(value));
                    html += \`<td>\${displayValue}</td>\`;
                });
                html += '</tr>';
            });
            
            html += '</tbody></table>';
            resultContainer.innerHTML = html;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    </script>
</body>
</html>`;
    }
}
