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
            if (this.messageDisposable) {
                this.messageDisposable.dispose();
                this.messageDisposable = undefined;
            }

            const isEditing = !!existingConnection;
            const title = isEditing ? `Edit Connection - ${existingConnection.name}` : 'Add New Connection';

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

            ConnectionEditor.currentPanel.webview.html = this.getWebviewContent(existingConnection);

            this.messageDisposable = ConnectionEditor.currentPanel.webview.onDidReceiveMessage(
                async (message) => {
                    switch (message.command) {
                        case 'selectFile':
                            this.handleFileSelection();
                            break;
                        case 'selectKeyFile':
                            this.handleKeyFileSelection();
                            break;
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

    private async handleFileSelection() {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'SQLite Database': ['db', 'sqlite', 'sqlite3', 's3db'] }
        });

        if (result && result.length > 0) {
            ConnectionEditor.currentPanel?.webview.postMessage({
                command: 'fileSelected',
                path: result[0].fsPath
            });
        }
    }

    private async handleKeyFileSelection() {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: 'Select SSH Private Key'
        });

        if (result && result.length > 0) {
            ConnectionEditor.currentPanel?.webview.postMessage({
                command: 'keyFileSelected',
                path: result[0].fsPath
            });
        }
    }

    private async testConnection(data: any): Promise<void> {
        try {
            const connection = this.buildConnection(data);
            
            ConnectionEditor.currentPanel?.webview.postMessage({
                command: 'testingConnection',
                message: 'Testing connection...'
            });

            let adapter;
            try {
                adapter = DatabaseAdapterFactory.createAdapter(connection);
            } catch (error) {
                throw new Error('Unsupported database type: ' + connection.type);
            }
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
            
            const adapter = DatabaseAdapterFactory.createAdapter(connection);
            await adapter.testConnection();
            await adapter.close();

            ConnectionEditor.currentPanel?.webview.postMessage({
                command: 'saveSuccess',
                message: isEditing ? 'Connection updated successfully!' : 'Connection added successfully!'
            });

            return { success: true, connection };
        } catch (error: unknown) {
            console.error('FULL ERROR OBJECT:', error);
            let errorMessage = 'Unknown error occurred';
            if (error instanceof Error) {
                errorMessage = error.message;
            } else if (typeof error === 'object' && error !== null) {
                errorMessage = (error as any).message || (error as any).code || JSON.stringify(error);
            } else if (typeof error === 'string') {
                errorMessage = error;
            }

            ConnectionEditor.currentPanel?.webview.postMessage({
                command: 'testConnectionError',
                message: errorMessage
            });
        }
        return { success: false };
    }

    private buildConnection(data: any): Connection {
        const { name, type, connectionMode, host, port, username, password, url, sqlitePath, useSSH, sshHost, sshPort, sshUsername, sshPassword, sshKeyPath, sshPassphrase } = data;

        if (type === 'SQLite') {
            // Since Host/Port/User/Pass are mandatory in your Connection interface,
            // we must provide dummy values for SQLite.
            const config: Connection = {
                name,
                type: 'SQLite',
                host: '',      // Dummy value
                port: 0,       // Dummy value
                username: '',  // Dummy value
                password: '',  // Dummy value
                sqlite: {
                    filePath: sqlitePath,
                    useSSH: !!useSSH
                }
            };

            if (useSSH) {
                config.sqlite!.sshConfig = {
                    host: sshHost,
                    port: parseInt(sshPort),
                    username: sshUsername,
                    password: sshPassword || undefined,
                    privateKeyPath: sshKeyPath || undefined,
                    passphrase: sshPassphrase || undefined
                };
            }
            return config;
        }

        if (connectionMode === 'url') {
            const parsedUrl = this.parseConnectionUrl(url, type);
            return {
                name,
                type,
                ...parsedUrl
                // Removed database property as it doesn't exist in your interface
            };
        } else {
            return {
                name,
                type,
                host,
                port: parseInt(port),
                username,
                password
                // Removed database property as it doesn't exist in your interface
            };
        }
    }

    private parseConnectionUrl(url: string, type: DatabaseType): { host: string; port: number; username: string; password: string } {
        try {
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
        
        // Define currentMode here so it is available for the HTML template
        // If we are editing, we default to 'individual' unless we build logic to detect URLs.
        const currentMode = 'individual';

        // General values
        const name = existingConnection?.name || '';
        const type = existingConnection?.type || 'PostgreSQL';

        // SQL / Network values
        const host = existingConnection?.host || 'localhost';
        const port = existingConnection?.port || (type === 'PostgreSQL' ? 5432 : 3306);
        const username = existingConnection?.username || '';
        const password = existingConnection?.password || '';
        
        // SQLite values
        const sqlitePath = existingConnection?.sqlite?.filePath || '';
        const useSSH = existingConnection?.sqlite?.useSSH || false;
        
        // SSH Values
        const sshHost = existingConnection?.sqlite?.sshConfig?.host || '';
        const sshPort = existingConnection?.sqlite?.sshConfig?.port || 22;
        const sshUsername = existingConnection?.sqlite?.sshConfig?.username || '';
        const sshPassword = existingConnection?.sqlite?.sshConfig?.password || '';
        const sshKeyPath = existingConnection?.sqlite?.sshConfig?.privateKeyPath || '';
        const sshPassphrase = existingConnection?.sqlite?.sshConfig?.passphrase || '';

        const connectionUrl = (existingConnection && type !== 'SQLite')
            ? `${type.toLowerCase()}://${username}:${password}@${host}:${port}/`
            : '';

        // Load SVG icons
        const postgresqlSvg = this.loadSvg('postgresql');
        const mysqlSvg = this.loadSvg('mysql');
        const mariadbSvg = this.loadSvg('mariadb');
        const sqliteSvg = this.loadSvg('sqlite');
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
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background-color: var(--vscode-editor-background); padding: 20px; line-height: 1.6; }
        .container { max-width: 700px; margin: 0 auto; background-color: var(--vscode-editor-background); }
        h1 { color: var(--vscode-foreground); margin-bottom: 10px; font-size: 24px; font-weight: 400; }
        .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 30px; font-size: 13px; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 6px; color: var(--vscode-foreground); font-size: 13px; font-weight: 500; }
        label .required { color: #f48771; }
        input[type="text"], input[type="password"], input[type="number"], select { width: 100%; padding: 8px 10px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; font-family: var(--vscode-font-family); font-size: 13px; outline: none; }
        input:focus, select:focus { border-color: var(--vscode-focusBorder); }
        input::placeholder { color: var(--vscode-input-placeholderForeground); }
        
        .connection-mode { display: flex; gap: 10px; margin-bottom: 20px; }
        .mode-button { flex: 1; padding: 10px; background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid transparent; border-radius: 2px; cursor: pointer; font-size: 13px; transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
        .mode-button:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .mode-button.active { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-focusBorder); }
        
        .mode-content { display: none; }
        .mode-content.active { display: block; }
        
        .hidden { display: none !important; }
        .database-type-selector { display: block; }
        
        .button-group { display: flex; gap: 10px; margin-top: 30px; padding-top: 20px; border-top: 1px solid var(--vscode-panel-border); }
        button { padding: 8px 16px; border: none; border-radius: 2px; cursor: pointer; font-size: 13px; font-family: var(--vscode-font-family); transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; }
        button svg { width: 16px; height: 16px; flex-shrink: 0; }
        .btn-primary { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        .btn-primary:hover { background-color: var(--vscode-button-hoverBackground); }
        .btn-secondary { background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        .btn-secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .btn-test { margin-left: auto; background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        .btn-test:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        
        .message { padding: 12px; margin-bottom: 20px; border-radius: 2px; font-size: 13px; display: none; }
        .message.show { display: block; }
        .message.success { background-color: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
        .message.error { background-color: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
        .message.info { background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        
        .grid-2 { display: grid; grid-template-columns: 2fr 1fr; gap: 15px; }
        .help-text { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
        
        .type-icons { display: flex; gap: 15px; margin-top: 8px; }
        .type-icon { flex: 1; padding: 12px; background-color: var(--vscode-button-secondaryBackground); border: 2px solid transparent; border-radius: 4px; cursor: pointer; text-align: center; transition: all 0.2s; display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .type-icon:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .type-icon.selected { border-color: var(--vscode-focusBorder); background-color: var(--vscode-input-background); }
        .type-icon-svg { width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; }
        .type-icon-svg svg { width: 100%; height: 100%; }
        .type-icon-label { font-size: 13px; font-weight: 500; }
        
        .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--vscode-button-secondaryForeground); border-radius: 50%; border-top-color: transparent; animation: spin 1s linear infinite; margin-right: 8px; vertical-align: middle; }
        @keyframes spin { to { transform: rotate(360deg); } }

        .file-input-wrapper { display: flex; gap: 8px; }
        .btn-icon { padding: 8px; }
        .checkbox-group { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; }
        input[type="checkbox"] { width: auto; }

        .ssh-section { margin-top: 20px; padding: 15px; border: 1px solid var(--vscode-input-border); border-radius: 4px; background: var(--vscode-editor-inactiveSelectionBackground); }
        .ssh-header { font-weight: bold; margin-bottom: 15px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 5px; }
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

            <div class="connection-mode" id="connectionModeSelector">
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
                    <div class="type-icon ${type === 'SQLite' ? 'selected' : ''}" data-type="SQLite">
                        <div class="type-icon-svg">${sqliteSvg}</div>
                        <div class="type-icon-label">SQLite</div>
                    </div>
                </div>
                <input type="hidden" id="type" name="type" value="${type}" required />
            </div>

            <div id="individualMode" class="mode-content active">
                <div class="grid-2">
                    <div class="form-group">
                        <label for="host">Host <span class="required">*</span></label>
                        <input type="text" id="host" name="host" value="${host}" placeholder="localhost" />
                    </div>
                    <div class="form-group">
                        <label for="port">Port <span class="required">*</span></label>
                        <input type="number" id="port" name="port" value="${port}" placeholder="5432" />
                    </div>
                </div>

                <div class="form-group">
                    <label for="username">Username <span class="required">*</span></label>
                    <input type="text" id="username" name="username" value="${username}" placeholder="postgres" />
                </div>

                <div class="form-group">
                    <label for="password">Password <span class="required">*</span></label>
                    <input type="password" id="password" name="password" value="${password}" placeholder="••••••••" />
                </div>
            </div>

            <div id="urlMode" class="mode-content">
                <div class="form-group">
                    <label for="url">Connection URL <span class="required">*</span></label>
                    <input type="text" id="url" name="url" value="${connectionUrl}" placeholder="postgresql://username:password@host:5432/database" />
                </div>
            </div>

            <div id="sqliteMode" class="mode-content">
                <div class="form-group">
                    <label for="sqlitePath">Database File Path <span class="required">*</span></label>
                    <div class="file-input-wrapper">
                        <input type="text" id="sqlitePath" name="sqlitePath" value="${sqlitePath}" placeholder="/path/to/database.sqlite" />
                        <button type="button" id="browseSqliteBtn" class="btn-secondary btn-icon" title="Browse File">
                            Folder
                        </button>
                    </div>
                    <div class="help-text">For remote SSH connections, enter the absolute path on the remote server.</div>
                </div>

                <div class="checkbox-group">
                    <input type="checkbox" id="useSSH" name="useSSH" ${useSSH ? 'checked' : ''}>
                    <label for="useSSH">Connect via SSH Tunnel</label>
                </div>

                <div id="sshConfigSection" class="ssh-section ${useSSH ? '' : 'hidden'}">
                    <div class="ssh-header">SSH Configuration</div>
                    <div class="grid-2">
                        <div class="form-group">
                            <label for="sshHost">SSH Host <span class="required">*</span></label>
                            <input type="text" id="sshHost" name="sshHost" value="${sshHost}" placeholder="192.168.1.10" />
                        </div>
                        <div class="form-group">
                            <label for="sshPort">SSH Port <span class="required">*</span></label>
                            <input type="number" id="sshPort" name="sshPort" value="${sshPort}" placeholder="22" />
                        </div>
                    </div>
                    <div class="form-group">
                        <label for="sshUsername">SSH Username <span class="required">*</span></label>
                        <input type="text" id="sshUsername" name="sshUsername" value="${sshUsername}" placeholder="root" />
                    </div>
                    <div class="form-group">
                        <label for="sshAuthMethod">Authentication Method</label>
                        <select id="sshAuthMethod">
                            <option value="password" ${!sshKeyPath ? 'selected' : ''}>Password</option>
                            <option value="keyfile" ${sshKeyPath ? 'selected' : ''}>Private Key File</option>
                        </select>
                    </div>
                    
                    <div id="sshPasswordGroup" class="form-group ${sshKeyPath ? 'hidden' : ''}">
                        <label for="sshPassword">SSH Password</label>
                        <input type="password" id="sshPassword" name="sshPassword" value="${sshPassword}" />
                    </div>

                    <div id="sshKeyGroup" class="form-group ${!sshKeyPath ? 'hidden' : ''}">
                        <label for="sshKeyPath">Private Key Path</label>
                        <div class="file-input-wrapper">
                            <input type="text" id="sshKeyPath" name="sshKeyPath" value="${sshKeyPath}" placeholder="/path/to/id_rsa" />
                            <button type="button" id="browseKeyBtn" class="btn-secondary btn-icon" title="Browse Key">
                                key
                            </button>
                        </div>
                        <div style="margin-top: 10px;">
                            <label for="sshPassphrase">Key Passphrase (Optional)</label>
                            <input type="password" id="sshPassphrase" name="sshPassphrase" value="${sshPassphrase}" />
                        </div>
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
        let currentMode = '${currentMode}'; 
        let currentType = '${type}';

        function updateUIState() {
            const isSQLite = currentType === 'SQLite';

            // Toggle Mode Selector (URL/Individual) visibility
            document.getElementById('connectionModeSelector').style.display = isSQLite ? 'none' : 'flex';

            // Hide Standard Fields if SQLite
            document.getElementById('individualMode').classList.remove('active');
            document.getElementById('urlMode').classList.remove('active');
            document.getElementById('sqliteMode').classList.remove('active');

            if (isSQLite) {
                document.getElementById('sqliteMode').classList.add('active');
            } else {
                if (currentMode === 'url') {
                    document.getElementById('urlMode').classList.add('active');
                } else {
                    document.getElementById('individualMode').classList.add('active');
                }
            }
            updateRequiredFields();
        }

        function updateRequiredFields() {
            const isSQLite = currentType === 'SQLite';
            const standardRequired = !isSQLite && currentMode === 'individual';
            document.getElementById('host').required = standardRequired;
            document.getElementById('port').required = standardRequired;
            document.getElementById('username').required = standardRequired;
            
            document.getElementById('url').required = !isSQLite && currentMode === 'url';
            document.getElementById('sqlitePath').required = isSQLite;
            
            const useSSH = document.getElementById('useSSH').checked;
            const sshRequired = isSQLite && useSSH;
            document.getElementById('sshHost').required = sshRequired;
            document.getElementById('sshPort').required = sshRequired;
            document.getElementById('sshUsername').required = sshRequired;
        }

        updateUIState();

        document.querySelectorAll('.type-icon').forEach(icon => {
            icon.addEventListener('click', () => {
                document.querySelectorAll('.type-icon').forEach(i => i.classList.remove('selected'));
                icon.classList.add('selected');
                currentType = icon.dataset.type;
                document.getElementById('type').value = currentType;
                
                if (currentType === 'PostgreSQL') document.getElementById('port').value = '5432';
                if (currentType === 'MySQL' || currentType === 'MariaDB') document.getElementById('port').value = '3306';

                updateUIState();
            });
        });

        document.querySelectorAll('.mode-button').forEach(button => {
            button.addEventListener('click', () => {
                currentMode = button.dataset.mode;
                document.querySelectorAll('.mode-button').forEach(b => b.classList.remove('active'));
                button.classList.add('active');
                updateUIState();
            });
        });

        document.getElementById('useSSH').addEventListener('change', (e) => {
            const sshSection = document.getElementById('sshConfigSection');
            if (e.target.checked) {
                sshSection.classList.remove('hidden');
            } else {
                sshSection.classList.add('hidden');
            }
            updateRequiredFields();
        });

        document.getElementById('sshAuthMethod').addEventListener('change', (e) => {
            const isKeyFile = e.target.value === 'keyfile';
            if (isKeyFile) {
                document.getElementById('sshPasswordGroup').classList.add('hidden');
                document.getElementById('sshKeyGroup').classList.remove('hidden');
            } else {
                document.getElementById('sshPasswordGroup').classList.remove('hidden');
                document.getElementById('sshKeyGroup').classList.add('hidden');
            }
        });

        document.getElementById('browseSqliteBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'selectFile' });
        });

        document.getElementById('browseKeyBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'selectKeyFile' });
        });

        function getFormData() {
            const data = {
                name: document.getElementById('name').value.trim(),
                type: currentType,
                connectionMode: currentMode
            };

            if (currentType === 'SQLite') {
                data.sqlitePath = document.getElementById('sqlitePath').value.trim();
                data.useSSH = document.getElementById('useSSH').checked;
                
                if (data.useSSH) {
                    data.sshHost = document.getElementById('sshHost').value.trim();
                    data.sshPort = document.getElementById('sshPort').value.trim();
                    data.sshUsername = document.getElementById('sshUsername').value.trim();
                    
                    const authMethod = document.getElementById('sshAuthMethod').value;
                    if (authMethod === 'password') {
                        data.sshPassword = document.getElementById('sshPassword').value;
                    } else {
                        data.sshKeyPath = document.getElementById('sshKeyPath').value.trim();
                        data.sshPassphrase = document.getElementById('sshPassphrase').value;
                    }
                }
            } else {
                if (currentMode === 'url') {
                    data.url = document.getElementById('url').value.trim();
                } else {
                    data.host = document.getElementById('host').value.trim();
                    data.port = document.getElementById('port').value.trim();
                    data.username = document.getElementById('username').value.trim();
                    data.password = document.getElementById('password').value;
                    // Database field removed from here
                }
            }
            return data;
        }

        document.getElementById('connectionForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const data = getFormData();
            if (!data.name) {
                showMessage('error', 'Connection name is required');
                return;
            }
            vscode.postMessage({ command: 'saveConnection', data });
        });

        document.getElementById('testBtn').addEventListener('click', () => {
            const data = getFormData();
            vscode.postMessage({ command: 'testConnection', data });
        });

        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'fileSelected':
                    document.getElementById('sqlitePath').value = message.path;
                    break;
                case 'keyFileSelected':
                    document.getElementById('sshKeyPath').value = message.path;
                    break;
                case 'testingConnection':
                    showMessage('info', '<span class="spinner"></span> ' + message.message);
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
                setTimeout(() => { messageDiv.classList.remove('show'); }, 3000);
            }
        }
    </script>
</body>
</html>`;
    }
}