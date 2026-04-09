/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
	const showVersionCommand = vscode.commands.registerCommand(
		'helloVersion.showVersion',
		() => {
			const extension = vscode.extensions.getExtension(context.extension.id);
			const version = extension?.packageJSON?.version ?? 'unknown';

			void vscode.window.showInformationMessage(
				`Hello from ${context.extension.id} v${version}`
			);
		}
	);

	context.subscriptions.push(showVersionCommand);
}

export function deactivate(): void { }
