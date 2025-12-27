import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Connection, DatabaseType } from './types';
import { DatabaseAdapterFactory } from './database';

export class ConnectionEditor {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private messageDisposable: vscode.Disposable | undefined;

    constructor(
        private context: vscode.ExtensionContext
    ) {}

    private loadSvg(iconName: string): string {
        try {
            const iconPath = path.join(this.context.extensionPath, 'src', 'icons', `${iconName}.svg`);
            return fs.readFileSync(iconPath, 'utf8');
        } catch (error) {
            console.error(`Failed to load SVG icon: ${iconName}`, error);
            return '';
        }
    }

    public async openEditor(existingConnection?: Connection): Promise<Connection | undefined> {
        return new Promise((resolve) => {
            // Dispose of previous message handler if panel is being reused
            if (this.messageDisposable) {
                this.messageDisposable.dispose();
                this.messageDisposable = undefined;
            }

            const isEditing = !!existingConnection;
            const title = isEditing ? `Edit Connection - ${existingConnection.name}` : 'Add New Connection';

            // Create new panel
            if (ConnectionEditor.currentPanel) {
                ConnectionEditor.currentPanel.dispose();
            }

            ConnectionEditor.currentPanel = vscode.window.createWebviewPanel(
                'connectionEditor',
                title,
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    enableForms: true,
                    localResourceRoots: []
                }
            );

            ConnectionEditor.currentPanel.onDidDispose(() => {
                ConnectionEditor.currentPanel = undefined;
                if (this.messageDisposable) {
                    this.messageDisposable.dispose();
                    this.messageDisposable = undefined;
                }
                resolve(undefined);
            });

            // Set the HTML content
            ConnectionEditor.currentPanel.webview.html = this.getWebviewContent(existingConnection);

            // Handle messages from the webview
            this.messageDisposable = ConnectionEditor.currentPanel.webview.onDidReceiveMessage(
                async (message) => {
                    switch (message.command) {
                        case 'testConnection':
                            await this.testConnection(message.data);
                            break;
                        case 'saveConnection':
                            const result = await this.validateAndSaveConnection(message.data, isEditing);
                            if (result.success) {
                                resolve(result.connection);
                                ConnectionEditor.currentPanel?.dispose();
                            }
                            break;
                        case 'cancel':
                            ConnectionEditor.currentPanel?.dispose();
                            resolve(undefined);
                            break;
                    }
                },
                undefined,
                this.context.subscriptions
            );
        });
    }

    private async testConnection(data: any): Promise<void> {
        try {
            const connection = this.buildConnection(data);
            const adapter = DatabaseAdapterFactory.createAdapter(connection);
            
            ConnectionEditor.currentPanel?.webview.postMessage({
                command: 'testingConnection',
                message: 'Testing connection...'
            });

            await adapter.testConnection();
            await adapter.close();

            ConnectionEditor.currentPanel?.webview.postMessage({
                command: 'testConnectionSuccess',
                message: 'Connection successful!'
            });
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            ConnectionEditor.currentPanel?.webview.postMessage({
                command: 'testConnectionError',
                message: errorMessage
            });
        }
    }

    private async validateAndSaveConnection(data: any, isEditing: boolean): Promise<{ success: boolean; connection?: Connection }> {
        try {
            const connection = this.buildConnection(data);
            
            // Test connection before saving
            const adapter = DatabaseAdapterFactory.createAdapter(connection);
            await adapter.testConnection();
            await adapter.close();

            ConnectionEditor.currentPanel?.webview.postMessage({
                command: 'saveSuccess',
                message: isEditing ? 'Connection updated successfully!' : 'Connection added successfully!'
            });

            return { success: true, connection };
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            ConnectionEditor.currentPanel?.webview.postMessage({
                command: 'saveError',
                message: errorMessage
            });
            return { success: false };
        }
    }

    private buildConnection(data: any): Connection {
        const { name, type, connectionMode, host, port, username, password, database, url } = data;

        if (connectionMode === 'url') {
            // Parse URL to extract connection details
            const parsedUrl = this.parseConnectionUrl(url, type);
            return {
                name,
                type,
                ...parsedUrl
            };
        } else {
            return {
                name,
                type,
                host,
                port: parseInt(port),
                username,
                password
            };
        }
    }

    private parseConnectionUrl(url: string, type: DatabaseType): { host: string; port: number; username: string; password: string } {
        try {
            // Handle different URL formats
            const urlPattern = /^(?:postgresql|mysql|mariadb):\/\/([^:]+):([^@]+)@([^:]+):(\d+)(?:\/.*)?$/;
            const match = url.match(urlPattern);
            
            if (!match) {
                throw new Error('Invalid connection URL format. Expected: protocol://username:password@host:port/database');
            }

            const [, username, password, host, port] = match;
            
            return {
                host,
                port: parseInt(port),
                username,
                password
            };
        } catch (error) {
            throw new Error('Failed to parse connection URL: ' + (error instanceof Error ? error.message : 'Unknown error'));
        }
    }

    private getWebviewContent(existingConnection?: Connection): string {
        const isEditing = !!existingConnection;
        
        // Pre-fill values if editing
        const name = existingConnection?.name || '';
        const type = existingConnection?.type || 'PostgreSQL';
        const host = existingConnection?.host || 'localhost';
        const port = existingConnection?.port || (type === 'PostgreSQL' ? 5432 : 3306);
        const username = existingConnection?.username || '';
        const password = existingConnection?.password || '';
        
        // Build connection URL from existing connection
        const connectionUrl = existingConnection 
            ? `${type.toLowerCase()}://${username}:${password}@${host}:${port}/`
            : '';

        // Load SVG icons
        const postgresqlSvg = this.loadSvg('postgresql');
        const mysqlSvg = this.loadSvg('mysql');
        const mariadbSvg = this.loadSvg('mariadb');
        const addSvg = this.loadSvg('add');
        const editSvg = this.loadSvg('edit');
        const plugSvg = this.loadSvg('plug');
        const closeSvg = this.loadSvg('close');
        const linkSvg = this.loadSvg('link');
        const listSvg = this.loadSvg('list');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${isEditing ? 'Edit' : 'Add'} Connection</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            line-height: 1.6;
        }

        .container {
            max-width: 700px;
            margin: 0 auto;
            background-color: var(--vscode-editor-background);
        }

        h1 {
            color: var(--vscode-foreground);
            margin-bottom: 10px;
            font-size: 24px;
            font-weight: 400;
        }

        .subtitle {
            color: var(--vscode-descriptionForeground);
            margin-bottom: 30px;
            font-size: 13px;
        }

        .form-group {
            margin-bottom: 20px;
        }

        label {
            display: block;
            margin-bottom: 6px;
            color: var(--vscode-foreground);
            font-size: 13px;
            font-weight: 500;
        }

        label .required {
            color: #f48771;
        }

        input[type="text"],
        input[type="password"],
        input[type="number"],
        select {
            width: 100%;
            padding: 8px 10px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-family: var(--vscode-font-family);
            font-size: 13px;
            outline: none;
        }

        input:focus,
        select:focus {
            border-color: var(--vscode-focusBorder);
        }

        input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        .connection-mode {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }

        .mode-button {
            flex: 1;
            padding: 10px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid transparent;
            border-radius: 2px;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }

        .mode-button svg {
            width: 16px;
            height: 16px;
            flex-shrink: 0;
        }

        .mode-button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .mode-button.active {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-focusBorder);
        }

        .mode-content {
            display: none;
        }

        .mode-content.active {
            display: block;
        }

        .database-type-selector {
            display: block;
        }

        .database-type-selector.hidden {
            display: none;
        }

        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-panel-border);
        }

        button {
            padding: 8px 16px;
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 13px;
            font-family: var(--vscode-font-family);
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }

        button svg {
            width: 16px;
            height: 16px;
            flex-shrink: 0;
        }

        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .btn-test {
            margin-left: auto;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .btn-test:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .message {
            padding: 12px;
            margin-bottom: 20px;
            border-radius: 2px;
            font-size: 13px;
            display: none;
        }

        .message.show {
            display: block;
        }

        .message.success {
            background-color: var(--vscode-testing-iconPassed);
            color: var(--vscode-editor-background);
        }

        .message.error {
            background-color: var(--vscode-errorForeground);
            color: var(--vscode-editor-background);
        }

        .message.info {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .grid-2 {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 15px;
        }

        .help-text {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }

        .type-icons {
            display: flex;
            gap: 15px;
            margin-top: 8px;
        }

        .type-icon {
            flex: 1;
            padding: 12px;
            background-color: var(--vscode-button-secondaryBackground);
            border: 2px solid transparent;
            border-radius: 4px;
            cursor: pointer;
            text-align: center;
            transition: all 0.2s;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
        }

        .type-icon:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .type-icon.selected {
            border-color: var(--vscode-focusBorder);
            background-color: var(--vscode-input-background);
        }

        .type-icon-svg {
            width: 48px;
            height: 48px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .type-icon-svg svg {
            width: 100%;
            height: 100%;
        }

        .type-icon-label {
            font-size: 13px;
            font-weight: 500;
        }

        .spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid var(--vscode-button-secondaryForeground);
            border-radius: 50%;
            border-top-color: transparent;
            animation: spin 1s linear infinite;
            margin-right: 8px;
            vertical-align: middle;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>${isEditing ? 'Edit Connection' : 'Add New Connection'}</h1>
        <p class="subtitle">${isEditing ? 'Update your database connection settings' : 'Configure a new database connection'}</p>

        <div id="message" class="message"></div>

        <form id="connectionForm">
            <div class="form-group">
                <label for="name">Connection Name <span class="required">*</span></label>
                <input type="text" id="name" name="name" value="${name}" placeholder="My Database" required />
            </div>

            <div class="connection-mode">
                <button type="button" class="mode-button active" data-mode="individual">
                    ${listSvg} Individual Fields
                </button>
                <button type="button" class="mode-button" data-mode="url">
                    ${linkSvg} Connection URL
                </button>
            </div>

            <div class="form-group database-type-selector">
                <label>Database Type <span class="required">*</span></label>
                <div class="type-icons">
                    <div class="type-icon ${type === 'PostgreSQL' ? 'selected' : ''}" data-type="PostgreSQL">
                        <div class="type-icon-svg">${postgresqlSvg}</div>
                        <div class="type-icon-label">PostgreSQL</div>
                    </div>
                    <div class="type-icon ${type === 'MySQL' ? 'selected' : ''}" data-type="MySQL">
                        <div class="type-icon-svg">${mysqlSvg}</div>
                        <div class="type-icon-label">MySQL</div>
                    </div>
                    <div class="type-icon ${type === 'MariaDB' ? 'selected' : ''}" data-type="MariaDB">
                        <div class="type-icon-svg">${mariadbSvg}</div>
                        <div class="type-icon-label">MariaDB</div>
                    </div>
                </div>
                <input type="hidden" id="type" name="type" value="${type}" required />
            </div>

            <div id="individualMode" class="mode-content active">
                <div class="grid-2">
                    <div class="form-group">
                        <label for="host">Host <span class="required">*</span></label>
                        <input type="text" id="host" name="host" value="${host}" placeholder="localhost" required />
                    </div>
                    <div class="form-group">
                        <label for="port">Port <span class="required">*</span></label>
                        <input type="number" id="port" name="port" value="${port}" placeholder="5432" required />
                    </div>
                </div>

                <div class="form-group">
                    <label for="username">Username <span class="required">*</span></label>
                    <input type="text" id="username" name="username" value="${username}" placeholder="postgres" required />
                </div>

                <div class="form-group">
                    <label for="password">Password <span class="required">*</span></label>
                    <input type="password" id="password" name="password" value="${password}" placeholder="••••••••" required />
                </div>

                <div class="form-group">
                    <label for="database">Database (Optional)</label>
                    <input type="text" id="database" name="database" placeholder="postgres" />
                    <div class="help-text">Leave empty to connect without selecting a specific database</div>
                </div>
            </div>

            <div id="urlMode" class="mode-content">
                <div class="form-group">
                    <label for="url">Connection URL <span class="required">*</span></label>
                    <input type="text" id="url" name="url" value="${connectionUrl}" placeholder="postgresql://username:password@host:5432/database" />
                    <div class="help-text">
                        Format: <strong>protocol://username:password@host:port/database</strong>
                    </div>
                </div>
            </div>

            <div class="button-group">
                <button type="submit" class="btn-primary">${isEditing ? editSvg + ' Update Connection' : addSvg + ' Add Connection'}</button>
                <button type="button" id="cancelBtn" class="btn-secondary">${closeSvg} Cancel</button>
                <button type="button" id="testBtn" class="btn-test">${plugSvg} Test Connection</button>
            </div>
        </form>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentMode = 'individual';
        let currentType = '${type}';

        // Database type selection
        document.querySelectorAll('.type-icon').forEach(icon => {
            icon.addEventListener('click', () => {
                document.querySelectorAll('.type-icon').forEach(i => i.classList.remove('selected'));
                icon.classList.add('selected');
                currentType = icon.dataset.type;
                document.getElementById('type').value = currentType;
                
                // Update default port based on type
                const portInput = document.getElementById('port');
                if (portInput && !portInput.value) {
                    portInput.value = currentType === 'PostgreSQL' ? '5432' : '3306';
                }
            });
        });

        // Connection mode switching
        document.querySelectorAll('.mode-button').forEach(button => {
            button.addEventListener('click', () => {
                const mode = button.dataset.mode;
                currentMode = mode;
                
                // Update active states
                document.querySelectorAll('.mode-button').forEach(b => b.classList.remove('active'));
                button.classList.add('active');
                
                document.querySelectorAll('.mode-content').forEach(c => c.classList.remove('active'));
                document.getElementById(mode + 'Mode').classList.add('active');
                
                // Show/hide database type selector based on mode
                const dbTypeSelector = document.querySelector('.database-type-selector');
                if (mode === 'url') {
                    dbTypeSelector.classList.add('hidden');
                } else {
                    dbTypeSelector.classList.remove('hidden');
                }
            });
        });

        // Form submission
        document.getElementById('connectionForm').addEventListener('submit', (e) => {
            e.preventDefault();
            
            const formData = {
                name: document.getElementById('name').value.trim(),
                type: currentType,
                connectionMode: currentMode
            };

            if (currentMode === 'individual') {
                formData.host = document.getElementById('host').value.trim();
                formData.port = document.getElementById('port').value.trim();
                formData.username = document.getElementById('username').value.trim();
                formData.password = document.getElementById('password').value;
                formData.database = document.getElementById('database').value.trim();
            } else {
                formData.url = document.getElementById('url').value.trim();
            }

            // Validate required fields
            if (!formData.name) {
                showMessage('error', 'Connection name is required');
                return;
            }

            if (currentMode === 'individual') {
                if (!formData.host || !formData.port || !formData.username || !formData.password) {
                    showMessage('error', 'Please fill in all required fields');
                    return;
                }
            } else {
                if (!formData.url) {
                    showMessage('error', 'Connection URL is required');
                    return;
                }
            }

            vscode.postMessage({
                command: 'saveConnection',
                data: formData
            });
        });

        // Test connection
        document.getElementById('testBtn').addEventListener('click', () => {
            const formData = {
                name: document.getElementById('name').value.trim(),
                type: currentType,
                connectionMode: currentMode
            };

            if (currentMode === 'individual') {
                formData.host = document.getElementById('host').value.trim();
                formData.port = document.getElementById('port').value.trim();
                formData.username = document.getElementById('username').value.trim();
                formData.password = document.getElementById('password').value;
                formData.database = document.getElementById('database').value.trim();
            } else {
                formData.url = document.getElementById('url').value.trim();
            }

            vscode.postMessage({
                command: 'testConnection',
                data: formData
            });
        });

        // Cancel button
        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'testingConnection':
                    showMessage('info', '<span class="spinner"></span>' + message.message);
                    break;
                case 'testConnectionSuccess':
                    showMessage('success', '✓ ' + message.message);
                    break;
                case 'testConnectionError':
                    showMessage('error', '✗ ' + message.message);
                    break;
                case 'saveSuccess':
                    showMessage('success', '✓ ' + message.message);
                    break;
                case 'saveError':
                    showMessage('error', '✗ ' + message.message);
                    break;
            }
        });

        function showMessage(type, text) {
            const messageDiv = document.getElementById('message');
            messageDiv.className = 'message show ' + type;
            messageDiv.innerHTML = text;
            
            if (type === 'success') {
                setTimeout(() => {
                    messageDiv.classList.remove('show');
                }, 3000);
            }
        }
    </script>
</body>
</html>`;
    }
}