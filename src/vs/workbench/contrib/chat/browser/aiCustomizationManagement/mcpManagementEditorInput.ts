/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

const McpManagementEditorIcon = registerIcon('mcp-management-editor-label-icon', Codicon.server, localize('mcpManagementEditorLabelIcon', 'Icon of the MCP Management editor label.'));

export class McpManagementEditorInput extends EditorInput {

	static readonly ID: string = 'workbench.input.mcpManagement';

	readonly resource = undefined;

	constructor() {
		super();
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof McpManagementEditorInput;
	}

	override get typeId(): string {
		return McpManagementEditorInput.ID;
	}

	override getName(): string {
		return localize('mcpManagementEditorInputName', "MCP Servers");
	}

	override getIcon(): ThemeIcon {
		return McpManagementEditorIcon;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
