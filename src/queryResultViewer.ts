import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class QueryResultViewer {
    private panel: vscode.WebviewPanel | undefined;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    private loadSvg(iconName: string): string {
        try {
            const iconPath = path.join(this.context.extensionPath, 'src', 'icons', `${iconName}.svg`);
            return fs.readFileSync(iconPath, 'utf8');
        } catch (error) {
            console.error(`Failed to load SVG icon: ${iconName}`, error);
            return '';
        }
    }

    public showResults(query: string, results: any, database?: string, connection?: string, tableName?: string, connectionObj?: any) {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'queryResults',
                'Query Results',
                { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            // Set icon for the panel with theme support
            this.panel.iconPath = {
                light: vscode.Uri.file(path.join(this.context.extensionPath, 'src', 'icons', 'output-light.svg')),
                dark: vscode.Uri.file(path.join(this.context.extensionPath, 'src', 'icons', 'output-dark.svg'))
            };

            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });
        }

        this.panel.webview.html = this.getHtmlContent(query, results, database, connection, tableName, connectionObj);
        this.panel.reveal(vscode.ViewColumn.Two, false);

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'exportCSV':
                        this.exportToCSV(message.results || results);
                        break;
                    case 'exportSQL':
                        this.exportToSQL(message.results || results, database);
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    private getHtmlContent(query: string, results: any, database?: string, connection?: string, tableName?: string, connectionObj?: any): string {
        const rowCount = results.rows?.length || 0;
        const affectedRows = results.affectedRows;
        
        let tableHtml = '';
        
        if (results.rows && results.rows.length > 0 && results.fields) {
            tableHtml = `
                <div class="table-wrapper">
                    <table>
                        <thead>
                            <tr>
                                ${results.fields.map((field: any) => `
                                    <th>
                                        ${field.isPrimaryKey ? '<span class="pk-indicator">🔑</span>' : ''}${field.isUnique ? '<span class="unique-indicator">🔐</span>' : ''}${field.isAutoIncrement ? '<span class="identity-indicator">↻</span>' : ''}${this.escapeHtml(field.name)}${field.isNullable === false ? '<span class="required-indicator">*</span>' : ''}
                                        ${field.dataType ? `<span class="column-type">(${this.escapeHtml(field.dataType)})</span>` : ''}
                                    </th>
                                `).join('')}
                            </tr>
                        </thead>
                        <tbody>
                            ${results.rows.map((row: any) => `
                                <tr>
                                    ${results.fields.map((field: any) => {
                                        const value = row[field.name];
                                        if (value === null || value === undefined) {
                                            return `<td><span class="null">NULL</span></td>`;
                                        }
                                        return `<td>${this.escapeHtml(String(value))}</td>`;
                                    }).join('')}
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Query Results</title>
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                    user-select: none;
                    -webkit-user-select: none;
                    -moz-user-select: none;
                    -ms-user-select: none;
                }
                
                body {
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 0;
                    overflow: hidden;
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                }
                
                .header {
                    padding: 8px 16px;
                    background-color: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-shrink: 0;
                    gap: 16px;
                }
                
                .header-left {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    font-size: 12px;
                }
                
                .header-center {
                    flex: 1;
                    text-align: center;
                }
                
                .header-right {
                    display: flex;
                    gap: 4px;
                }
                
                .info {
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                }
                
                .info strong {
                    color: var(--vscode-foreground);
                }
                
                .row-count {
                    color: var(--vscode-charts-green);
                    font-weight: 600;
                    font-size: 14px;
                }
                
                .export-btn {
                    background: transparent;
                    border: none;
                    padding: 4px 8px;
                    cursor: pointer;
                    font-size: 16px;
                    border-radius: 3px;
                    opacity: 0.7;
                    transition: opacity 0.2s, background-color 0.2s;
                }
                
                .export-btn.csv {
                    color: var(--vscode-charts-green);
                }
                
                .export-btn.sql {
                    color: var(--vscode-charts-yellow);
                }
                
                .export-btn:hover {
                    opacity: 1;
                    background-color: var(--vscode-toolbar-hoverBackground);
                }
                
                .table-container {
                    flex: 1;
                    overflow: auto;
                    padding: 16px;
                }
                
                .table-wrapper {
                    overflow: auto;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                }
                
                table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 13px;
                }
                
                th {
                    background-color: var(--vscode-editorGroupHeader-tabsBackground);
                    color: var(--vscode-foreground);
                    padding: 10px 12px;
                    text-align: left;
                    font-weight: 600;
                    position: sticky;
                    top: 0;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    border-right: 1px solid var(--vscode-panel-border);
                    white-space: nowrap;
                }
                
                th:last-child {
                    border-right: none;
                }
                
                .pk-indicator {
                    color: var(--vscode-symbolIcon-keyForeground);
                    margin-right: 5px;
                    display: inline-flex;
                    align-items: center;
                    vertical-align: middle;
                    font-size: 10px;
                }

                .pk-indicator svg {
                    width: 12px;
                    height: 12px;
                    fill: currentColor;
                }

                .unique-indicator {
                    color: var(--vscode-charts-blue);
                    margin-right: 5px;
                    display: inline-flex;
                    align-items: center;
                    vertical-align: middle;
                    font-size: 10px;
                }

                .identity-indicator {
                    color: var(--vscode-charts-green);
                    margin-right: 5px;
                    display: inline-flex;
                    align-items: center;
                    vertical-align: middle;
                    font-size: 12px;
                    font-weight: bold;
                }

                .required-indicator {
                    color: #f14c4c;
                    margin-left: 3px;
                    font-size: 14px;
                }

                .column-type {
                    color: var(--vscode-descriptionForeground);
                    font-weight: normal;
                    margin-left: 5px;
                    opacity: 0.7;
                }
                
                td {
                    padding: 8px 12px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    border-right: 1px solid var(--vscode-panel-border);
                }
                
                td:last-child {
                    border-right: none;
                }
                
                tr:last-child td {
                    border-bottom: none;
                }
                
                tr:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                
                .null {
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                }
                
                .empty-state {
                    text-align: center;
                    padding: 40px;
                    color: var(--vscode-descriptionForeground);
                }
                
                .success-message {
                    padding: 40px;
                    text-align: center;
                }
                
                .success-icon {
                    font-size: 48px;
                    color: var(--vscode-charts-green);
                    margin-bottom: 16px;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <div class="header-left">
                    ${connection ? `<div class="info">Connection: <strong>${this.escapeHtml(connection)}</strong></div>` : ''}
                    ${database ? `<div class="info">Database: <strong>${this.escapeHtml(database)}</strong></div>` : ''}
                </div>
                <div class="header-center">
                    ${rowCount > 0 ? `
                        <span class="row-count">${rowCount}</span> <span class="info">row${rowCount !== 1 ? 's' : ''} returned</span>
                    ` : affectedRows !== undefined ? `
                        <span class="row-count">${affectedRows}</span> <span class="info">row${affectedRows !== 1 ? 's' : ''} affected</span>
                    ` : ''}
                </div>
                ${rowCount > 0 ? `
                    <div class="header-right">
                        <button class="export-btn csv" onclick="exportCSV()" title="Export as CSV">
                            ${this.loadSvg('graph')}
                        </button>
                        <button class="export-btn sql" onclick="exportSQL()" title="Export as SQL">
                            ${this.loadSvg('database')}
                        </button>
                    </div>
                ` : '<div class="header-right"></div>'}
            </div>
            
            <div class="table-container">
                ${rowCount > 0 ? tableHtml : affectedRows !== undefined ? `
                    <div class="success-message">
                        <div class="success-icon">✓</div>
                        <div>Query executed successfully!</div>
                    </div>
                ` : `
                    <div class="empty-state">No results to display</div>
                `}
            </div>
            
            <script>
                const vscode = acquireVsCodeApi();
                
                // Store results in webview state
                const results = ${JSON.stringify(results)};
                
                function exportCSV() {
                    vscode.postMessage({ 
                        command: 'exportCSV',
                        results: results
                    });
                }
                
                function exportSQL() {
                    vscode.postMessage({ 
                        command: 'exportSQL',
                        results: results
                    });
                }
            </script>
        </body>
        </html>`;
    }

    private escapeHtml(text: string): string {
        const div = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        return div;
    }

    private formatValue(value: any): string {
        if (value === null || value === undefined) {
            return '';
        }
        
        // Check if it's a date string (contains "GMT" or looks like a timestamp)
        const stringValue = String(value);
        if (stringValue.includes('GMT') || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(stringValue)) {
            try {
                const date = new Date(stringValue);
                if (!isNaN(date.getTime())) {
                    // Format as YYYY-MM-DDTHH:MM
                    const year = date.getFullYear();
                    const month = String(date.getMonth() + 1).padStart(2, '0');
                    const day = String(date.getDate()).padStart(2, '0');
                    const hours = String(date.getHours()).padStart(2, '0');
                    const minutes = String(date.getMinutes()).padStart(2, '0');
                    return `${year}-${month}-${day}T${hours}:${minutes}`;
                }
            } catch (e) {
                // If parsing fails, return the original string
            }
        }
        
        return stringValue;
    }

    private async exportToCSV(results: any) {
        if (!results.rows || results.rows.length === 0) {
            vscode.window.showWarningMessage('No data to export');
            return;
        }

        const headers = results.fields.map((f: { name: string }) => f.name);
        
        // Create CSV content without quotes
        let csv = headers.join(',') + '\n';
        
        results.rows.forEach((row: any) => {
            const values = headers.map((h: string) => {
                const value = row[h];
                return this.formatValue(value);
            });
            csv += values.join(',') + '\n';
        });

        // Save file
        const uri = await vscode.window.showSaveDialog({
            filters: { 'CSV Files': ['csv'] },
            defaultUri: vscode.Uri.file('query_results.csv')
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf8'));
            vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        }
    }

    private async exportToSQL(results: any, database?: string) {
        if (!results.rows || results.rows.length === 0) {
            vscode.window.showWarningMessage('No data to export');
            return;
        }

        const headers = results.fields.map((f: { name: string }) => f.name);
        
        // Ask for table name
        const tableName = await vscode.window.showInputBox({
            prompt: 'Enter table name for SQL export',
            placeHolder: 'my_table',
            value: 'exported_data'
        });

        if (!tableName) {
            return;
        }

        // Create SQL content
        let sql = `-- Exported Query Results\n`;
        if (database) {
            sql += `-- Database: ${database}\n`;
        }
        sql += `-- Rows: ${results.rows.length}\n\n`;

        // Create table structure with proper types and constraints
        sql += `CREATE TABLE IF NOT EXISTS \`${tableName}\` (\n`;
        
        const columnDefs = results.fields.map((field: any) => {
            let def = `  \`${field.name}\` ${field.dataType || 'TEXT'}`;
            
            // Add NOT NULL if column is not nullable
            if (field.isNullable === false) {
                def += ' NOT NULL';
            }
            
            // Add AUTO_INCREMENT if applicable
            if (field.isAutoIncrement) {
                def += ' AUTO_INCREMENT';
            }
            
            // Add UNIQUE if applicable (but not if it's a primary key)
            if (field.isUnique && !field.isPrimaryKey) {
                def += ' UNIQUE';
            }
            
            return def;
        });
        
        sql += columnDefs.join(',\n');
        
        // Add PRIMARY KEY constraint if any
        const primaryKeys = results.fields
            .filter((f: any) => f.isPrimaryKey)
            .map((f: any) => `\`${f.name}\``);
        
        if (primaryKeys.length > 0) {
            sql += `,\n  PRIMARY KEY (${primaryKeys.join(', ')})`;
        }
        
        sql += '\n);\n\n';

        // Insert statements
        results.rows.forEach((row: any) => {
            const columnNames = headers.map((h: string) => `\`${h}\``).join(', ');
            const values = headers.map((h: string) => {
                const value = row[h];
                if (value === null || value === undefined) {
                    return 'NULL';
                }
                if (typeof value === 'number') {
                    return value;
                }
                if (typeof value === 'boolean') {
                    return value ? '1' : '0';
                }
                // Format dates and escape single quotes
                const formattedValue = this.formatValue(value);
                const stringValue = formattedValue.replace(/'/g, "''");
                return `'${stringValue}'`;
            }).join(', ');
            
            sql += `INSERT INTO \`${tableName}\` (${columnNames}) VALUES (${values});\n`;
        });

        // Save file
        const uri = await vscode.window.showSaveDialog({
            filters: { 'SQL Files': ['sql'] },
            defaultUri: vscode.Uri.file(`${tableName}.sql`)
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(sql, 'utf8'));
            vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        }
    }

    public dispose() {
        if (this.panel) {
            this.panel.dispose();
        }
    }
}