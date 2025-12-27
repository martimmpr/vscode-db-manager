import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Connection } from './types';
import { DatabaseAdapterFactory, ColumnDefinition, ColumnInfo } from './database';

type EditorMode = 'create' | 'rename' | 'addColumn' | 'editColumn';

interface EditorOptions {
    mode: EditorMode;
    connection: Connection;
    database: string;
    tableName?: string;
    columnName?: string;
    existingColumns?: ColumnInfo[];
}

export class TableEditor {
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

    public async openEditor(options: EditorOptions): Promise<any> {
        return new Promise((resolve) => {
            // Dispose of previous message handler if panel is being reused
            if (this.messageDisposable) {
                this.messageDisposable.dispose();
                this.messageDisposable = undefined;
            }

            const title = this.getTitle(options);

            // Create new panel
            if (TableEditor.currentPanel) {
                TableEditor.currentPanel.dispose();
            }

            TableEditor.currentPanel = vscode.window.createWebviewPanel(
                'tableEditor',
                title,
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    enableForms: true,
                    localResourceRoots: []
                }
            );

            TableEditor.currentPanel.onDidDispose(() => {
                TableEditor.currentPanel = undefined;
                if (this.messageDisposable) {
                    this.messageDisposable.dispose();
                    this.messageDisposable = undefined;
                }
                resolve(undefined);
            });

            // Set the HTML content
            TableEditor.currentPanel.webview.html = this.getWebviewContent(options);

            // Handle messages from the webview
            this.messageDisposable = TableEditor.currentPanel.webview.onDidReceiveMessage(
                async (message) => {
                    switch (message.command) {
                        case 'save':
                            const result = await this.handleSave(options, message.data);
                            if (result.success) {
                                resolve(result.data);
                                TableEditor.currentPanel?.dispose();
                            }
                            break;
                        case 'cancel':
                            TableEditor.currentPanel?.dispose();
                            resolve(undefined);
                            break;
                    }
                },
                undefined,
                this.context.subscriptions
            );
        });
    }

    private getTitle(options: EditorOptions): string {
        switch (options.mode) {
            case 'create':
                return `Create Table - ${options.database}`;
            case 'rename':
                return `Rename Table - ${options.tableName}`;
            case 'addColumn':
                return `Add Column - ${options.tableName}`;
            case 'editColumn':
                return `Edit Column - ${options.tableName}.${options.columnName}`;
        }
    }

    private async handleSave(options: EditorOptions, data: any): Promise<{ success: boolean; data?: any }> {
        try {
            const adapter = DatabaseAdapterFactory.createAdapter(options.connection);

            switch (options.mode) {
                case 'create':
                    await adapter.createTable(options.database, data.tableName, data.columns);
                    TableEditor.currentPanel?.webview.postMessage({
                        command: 'saveSuccess',
                        message: `Table "${data.tableName}" created successfully!`
                    });
                    break;

                case 'rename':
                    await adapter.renameTable(options.database, options.tableName!, data.newTableName);
                    TableEditor.currentPanel?.webview.postMessage({
                        command: 'saveSuccess',
                        message: `Table renamed to "${data.newTableName}" successfully!`
                    });
                    break;

                case 'addColumn':
                    await adapter.addColumn(
                        options.database,
                        options.tableName!,
                        data.columnName,
                        data.columnType,
                        data.constraints
                    );
                    TableEditor.currentPanel?.webview.postMessage({
                        command: 'saveSuccess',
                        message: `Column "${data.columnName}" added successfully!`
                    });
                    break;

                case 'editColumn':
                    // For edit, we need to remove old column and add new one
                    // This is a limitation but works for all databases
                    await adapter.removeColumn(options.database, options.tableName!, options.columnName!);
                    await adapter.addColumn(
                        options.database,
                        options.tableName!,
                        data.columnName,
                        data.columnType,
                        data.constraints
                    );
                    TableEditor.currentPanel?.webview.postMessage({
                        command: 'saveSuccess',
                        message: `Column "${data.columnName}" updated successfully!`
                    });
                    break;
            }

            await adapter.close();
            return { success: true, data };
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            TableEditor.currentPanel?.webview.postMessage({
                command: 'saveError',
                message: errorMessage
            });
            return { success: false };
        }
    }

    private getWebviewContent(options: EditorOptions): string {
        const addSvg = this.loadSvg('add');
        const editSvg = this.loadSvg('edit');
        const closeSvg = this.loadSvg('close');
        const deleteSvg = this.loadSvg('delete');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.getTitle(options)}</title>
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
            max-width: 800px;
            margin: 0 auto;
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

        .btn-danger {
            background-color: var(--vscode-errorForeground);
            color: var(--vscode-editor-background);
        }

        .btn-danger:hover {
            opacity: 0.9;
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

        .columns-list {
            margin-top: 20px;
        }

        .column-item {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-bottom: 15px;
            padding: 15px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
        }

        .column-item input,
        .column-item select {
            flex: 1;
        }

        .column-item .btn-danger {
            padding: 6px 12px;
        }
        
        .column-constraints-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
        }
        
        .column-constraints-group {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
        }

        .constraints-group {
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
            margin-top: 10px;
        }

        .checkbox-label {
            display: flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
            font-weight: normal;
        }

        .checkbox-label input[type="checkbox"] {
            width: auto;
            outline: none;
        }
        
        .checkbox-label input[type="checkbox"]:focus {
            outline: none;
        }

        .help-text {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
    </style>
</head>
<body>
    <div class="container">
        ${this.getFormContent(options, addSvg, editSvg, closeSvg, deleteSvg)}
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        ${this.getJavaScriptContent(options, deleteSvg)}
    </script>
</body>
</html>`;
    }

    private getFormContent(options: EditorOptions, addSvg: string, editSvg: string, closeSvg: string, deleteSvg: string): string {
        switch (options.mode) {
            case 'create':
                return this.getCreateTableForm(addSvg, closeSvg, deleteSvg);
            case 'rename':
                return this.getRenameTableForm(options.tableName!, editSvg, closeSvg);
            case 'addColumn':
                return this.getAddColumnForm(options.tableName!, addSvg, closeSvg);
            case 'editColumn':
                return this.getEditColumnForm(options, editSvg, closeSvg);
        }
    }

    private getCreateTableForm(addSvg: string, closeSvg: string, deleteSvg: string): string {
        return `
        <h1>Create Table</h1>
        <p class="subtitle">Define a new table structure</p>

        <div id="message" class="message"></div>

        <form id="tableForm">
            <div class="form-group">
                <label for="tableName">Table Name <span class="required">*</span></label>
                <input type="text" id="tableName" name="tableName" placeholder="users" required />
            </div>

            <div class="form-group">
                <label>Columns <span class="required">*</span></label>
                <div class="help-text">Add at least one column to the table</div>
                <div id="columnsList" class="columns-list"></div>
                <button type="button" id="addColumnBtn" class="btn-secondary" style="margin-top: 10px;">
                    ${addSvg} Add Column
                </button>
            </div>

            <div class="button-group">
                <button type="submit" class="btn-primary">${addSvg} Create Table</button>
                <button type="button" id="cancelBtn" class="btn-secondary">${closeSvg} Cancel</button>
            </div>
        </form>`;
    }

    private getRenameTableForm(tableName: string, editSvg: string, closeSvg: string): string {
        return `
        <h1>Rename Table</h1>
        <p class="subtitle">Rename table "${tableName}"</p>

        <div id="message" class="message"></div>

        <form id="tableForm">
            <div class="form-group">
                <label for="newTableName">New Table Name <span class="required">*</span></label>
                <input type="text" id="newTableName" name="newTableName" value="${tableName}" placeholder="new_table_name" required />
            </div>

            <div class="button-group">
                <button type="submit" class="btn-primary">${editSvg} Rename Table</button>
                <button type="button" id="cancelBtn" class="btn-secondary">${closeSvg} Cancel</button>
            </div>
        </form>`;
    }

    private getAddColumnForm(tableName: string, addSvg: string, closeSvg: string): string {
        return `
        <h1>Add Column</h1>
        <p class="subtitle">Add a new column to table "${tableName}"</p>

        <div id="message" class="message"></div>

        <form id="tableForm">
            <div class="form-group">
                <label for="columnName">Column Name <span class="required">*</span></label>
                <input type="text" id="columnName" name="columnName" placeholder="email" required />
            </div>

            <div class="form-group">
                <label for="columnType">Data Type <span class="required">*</span></label>
                <select id="columnType" name="columnType" required>
                    <option value="VARCHAR(255)">VARCHAR(255)</option>
                    <option value="TEXT">TEXT</option>
                    <option value="INTEGER">INTEGER</option>
                    <option value="BIGINT">BIGINT</option>
                    <option value="DECIMAL(10,2)">DECIMAL(10,2)</option>
                    <option value="BOOLEAN">BOOLEAN</option>
                    <option value="DATE">DATE</option>
                    <option value="TIMESTAMP">TIMESTAMP</option>
                    <option value="JSON">JSON</option>
                </select>
            </div>

            <div class="form-group">
                <label>Constraints</label>
                <div class="constraints-group">
                    <label class="checkbox-label">
                        <input type="checkbox" name="constraint" value="PRIMARY KEY" />
                        Primary Key
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" name="constraint" value="NOT NULL" />
                        Not Null
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" name="constraint" value="UNIQUE" />
                        Unique
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" name="constraint" value="AUTO INCREMENT" />
                        Auto Increment
                    </label>
                </div>
            </div>

            <div class="button-group">
                <button type="submit" class="btn-primary">${addSvg} Add Column</button>
                <button type="button" id="cancelBtn" class="btn-secondary">${closeSvg} Cancel</button>
            </div>
        </form>`;
    }

    private getEditColumnForm(options: EditorOptions, editSvg: string, closeSvg: string): string {
        const column = options.existingColumns?.find(c => c.column_name === options.columnName);
        const dataType = column?.data_type?.toUpperCase() || 'VARCHAR(255)';
        
        return `
        <h1>Edit Column</h1>
        <p class="subtitle">Edit column "${options.columnName}" in table "${options.tableName}"</p>

        <div id="message" class="message"></div>

        <form id="tableForm">
            <div class="form-group">
                <label for="columnName">Column Name <span class="required">*</span></label>
                <input type="text" id="columnName" name="columnName" value="${options.columnName}" placeholder="email" required />
            </div>

            <div class="form-group">
                <label for="columnType">Data Type <span class="required">*</span></label>
                <select id="columnType" name="columnType" required>
                    <option value="VARCHAR(255)" ${dataType.includes('VARCHAR') ? 'selected' : ''}>VARCHAR(255)</option>
                    <option value="TEXT" ${dataType === 'TEXT' ? 'selected' : ''}>TEXT</option>
                    <option value="INTEGER" ${dataType === 'INTEGER' || dataType === 'INT' ? 'selected' : ''}>INTEGER</option>
                    <option value="BIGINT" ${dataType === 'BIGINT' ? 'selected' : ''}>BIGINT</option>
                    <option value="DECIMAL(10,2)" ${dataType.includes('DECIMAL') ? 'selected' : ''}>DECIMAL(10,2)</option>
                    <option value="BOOLEAN" ${dataType === 'BOOLEAN' || dataType === 'BOOL' ? 'selected' : ''}>BOOLEAN</option>
                    <option value="DATE" ${dataType === 'DATE' ? 'selected' : ''}>DATE</option>
                    <option value="TIMESTAMP" ${dataType === 'TIMESTAMP' ? 'selected' : ''}>TIMESTAMP</option>
                    <option value="JSON" ${dataType === 'JSON' ? 'selected' : ''}>JSON</option>
                </select>
            </div>

            <div class="form-group">
                <label>Constraints</label>
                <div class="constraints-group">
                    <label class="checkbox-label">
                        <input type="checkbox" name="constraint" value="PRIMARY KEY" />
                        Primary Key
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" name="constraint" value="NOT NULL" ${column?.is_nullable === 'NO' ? 'checked' : ''} />
                        Not Null
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" name="constraint" value="UNIQUE" />
                        Unique
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" name="constraint" value="AUTO INCREMENT" />
                        Auto Increment
                    </label>
                </div>
            </div>

            <div class="button-group">
                <button type="submit" class="btn-primary">${editSvg} Update Column</button>
                <button type="button" id="cancelBtn" class="btn-secondary">${closeSvg} Cancel</button>
            </div>
        </form>`;
    }

    private getJavaScriptContent(options: EditorOptions, deleteSvg?: string): string {
        if (options.mode === 'create') {
            return this.getCreateTableJS(deleteSvg || '');
        } else if (options.mode === 'rename') {
            return this.getRenameTableJS();
        } else {
            return this.getColumnFormJS();
        }
    }

    private getCreateTableJS(deleteSvg: string): string {
        const escapedDeleteSvg = deleteSvg.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
        return `
        const deleteIconSvg = \`${escapedDeleteSvg}\`;
        let columns = [];

        document.getElementById('addColumnBtn').addEventListener('click', () => {
            const columnItem = document.createElement('div');
            columnItem.className = 'column-item';
            
            const nameInput = document.createElement('div');
            nameInput.style.cssText = 'flex: 1; min-width: 200px;';
            nameInput.innerHTML = '<input type="text" placeholder="Column name" class="column-name" required style="width: 100%;" />';
            
            const typeSelect = document.createElement('div');
            typeSelect.style.cssText = 'flex: 1; min-width: 180px;';
            typeSelect.innerHTML = \`
                <select class="column-type" required style="width: 100%;">
                    <option value="VARCHAR(255)">VARCHAR(255)</option>
                    <option value="VARCHAR(100)">VARCHAR(100)</option>
                    <option value="VARCHAR(50)">VARCHAR(50)</option>
                    <option value="CHAR(10)">CHAR(10)</option>
                    <option value="TEXT">TEXT</option>
                    <option value="MEDIUMTEXT">MEDIUMTEXT</option>
                    <option value="LONGTEXT">LONGTEXT</option>
                    <option value="INTEGER">INTEGER</option>
                    <option value="BIGINT">BIGINT</option>
                    <option value="SMALLINT">SMALLINT</option>
                    <option value="TINYINT">TINYINT</option>
                    <option value="DECIMAL(10,2)">DECIMAL(10,2)</option>
                    <option value="DECIMAL(15,2)">DECIMAL(15,2)</option>
                    <option value="FLOAT">FLOAT</option>
                    <option value="DOUBLE">DOUBLE</option>
                    <option value="BOOLEAN">BOOLEAN</option>
                    <option value="DATE">DATE</option>
                    <option value="DATETIME">DATETIME</option>
                    <option value="TIMESTAMP">TIMESTAMP</option>
                    <option value="TIME">TIME</option>
                    <option value="JSON">JSON</option>
                    <option value="JSONB">JSONB</option>
                    <option value="UUID">UUID</option>
                    <option value="BLOB">BLOB</option>
                    <option value="ENUM">ENUM</option>
                </select>
            \`;
            
            const defaultInput = document.createElement('div');
            defaultInput.style.cssText = 'flex: 1; min-width: 180px;';
            defaultInput.innerHTML = '<input type="text" placeholder="Default value (optional)" class="column-default" style="width: 100%;" />';
            
            const topRow = document.createElement('div');
            topRow.style.cssText = 'display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap;';
            topRow.appendChild(nameInput);
            topRow.appendChild(typeSelect);
            topRow.appendChild(defaultInput);
            
            const constraintsGroup = document.createElement('div');
            constraintsGroup.className = 'column-constraints-group';
            constraintsGroup.innerHTML = \`
                <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                    <input type="checkbox" class="column-primary" />
                    <span>PRIMARY KEY</span>
                </label>
                <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                    <input type="checkbox" class="column-notnull" />
                    <span>NOT NULL</span>
                </label>
                <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                    <input type="checkbox" class="column-unique" />
                    <span>UNIQUE</span>
                </label>
                <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                    <input type="checkbox" class="column-autoincrement" />
                    <span>AUTO INCREMENT</span>
                </label>
            \`;
            
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'btn-danger remove-column';
            removeBtn.innerHTML = deleteIconSvg + ' Remove';
            removeBtn.addEventListener('click', () => {
                columnItem.remove();
            });
            
            const constraintsRow = document.createElement('div');
            constraintsRow.className = 'column-constraints-row';
            constraintsRow.appendChild(constraintsGroup);
            constraintsRow.appendChild(removeBtn);
            
            columnItem.appendChild(topRow);
            columnItem.appendChild(constraintsRow);
            
            document.getElementById('columnsList').appendChild(columnItem);
        });

        // Add first column automatically
        document.getElementById('addColumnBtn').click();

        document.getElementById('tableForm').addEventListener('submit', (e) => {
            e.preventDefault();
            
            const tableName = document.getElementById('tableName').value.trim();
            const columnItems = document.querySelectorAll('.column-item');
            const columns = [];
            
            columnItems.forEach(item => {
                const name = item.querySelector('.column-name').value.trim();
                const type = item.querySelector('.column-type').value;
                const defaultValue = item.querySelector('.column-default').value.trim();
                const isPrimary = item.querySelector('.column-primary').checked;
                const isNotNull = item.querySelector('.column-notnull').checked;
                const isUnique = item.querySelector('.column-unique').checked;
                const isAutoIncrement = item.querySelector('.column-autoincrement').checked;
                
                if (name && type) {
                    const constraints = [];
                    if (isPrimary) constraints.push('PRIMARY KEY');
                    if (isNotNull) constraints.push('NOT NULL');
                    if (isUnique) constraints.push('UNIQUE');
                    if (isAutoIncrement) constraints.push('AUTO_INCREMENT');
                    
                    columns.push({
                        name: name,
                        type: type,
                        constraints: constraints,
                        defaultValue: defaultValue || undefined
                    });
                }
            });
            
            if (!tableName) {
                showMessage('error', 'Table name is required!');
                return;
            }
            
            if (columns.length === 0) {
                showMessage('error', 'At least one column is required!');
                return;
            }
            
            vscode.postMessage({
                command: 'save',
                data: { tableName, columns }
            });
        });

        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
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
        }`;
    }

    private getRenameTableJS(): string {
        return `
        document.getElementById('tableForm').addEventListener('submit', (e) => {
            e.preventDefault();
            
            const newTableName = document.getElementById('newTableName').value.trim();
            
            if (!newTableName) {
                showMessage('error', 'Table name is required!');
                return;
            }
            
            vscode.postMessage({
                command: 'save',
                data: { newTableName }
            });
        });

        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
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
        }`;
    }

    private getColumnFormJS(): string {
        return `
        document.getElementById('tableForm').addEventListener('submit', (e) => {
            e.preventDefault();
            
            const columnName = document.getElementById('columnName').value.trim();
            const columnType = document.getElementById('columnType').value;
            const constraintCheckboxes = document.querySelectorAll('input[name="constraint"]:checked');
            const constraints = Array.from(constraintCheckboxes).map(cb => {
                if (cb.value === 'AUTO INCREMENT') {
                    return 'GENERATED ALWAYS AS IDENTITY';
                }
                return cb.value;
            });
            
            if (!columnName) {
                showMessage('error', 'Column name is required!');
                return;
            }
            
            vscode.postMessage({
                command: 'save',
                data: { columnName, columnType, constraints }
            });
        });

        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
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
        }`;
    }
}