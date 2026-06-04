import * as vscode from 'vscode';
const edit = new vscode.WorkspaceEdit();
edit.deleteFile(vscode.Uri.file('/tmp'), { moveToTrash: true });
