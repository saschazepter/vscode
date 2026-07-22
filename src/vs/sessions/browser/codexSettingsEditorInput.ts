/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { localize } from '../../nls.js';
import { IModalEditorOptions, IModalEditorOptionsProvider } from '../../platform/editor/common/editor.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../workbench/common/editor.js';
import { EditorInput } from '../../workbench/common/editor/editorInput.js';

export class CodexSettingsEditorInput extends EditorInput implements IModalEditorOptionsProvider {
	static readonly ID = 'workbench.input.codexSettings';

	readonly resource = undefined;

	constructor(readonly providerId?: string) {
		super();
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.RequiresModal;
	}

	override get typeId(): string {
		return CodexSettingsEditorInput.ID;
	}

	override getName(): string {
		return localize('codexSettingsEditorInputName', "Codex Settings");
	}

	override getIcon(): ThemeIcon {
		return Codicon.settingsGear;
	}

	getModalEditorOptions(): IModalEditorOptions {
		return { compactHeader: true };
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof CodexSettingsEditorInput && otherInput.providerId === this.providerId;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
