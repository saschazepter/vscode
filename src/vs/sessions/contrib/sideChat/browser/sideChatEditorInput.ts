/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput, Verbosity } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

export class SideChatEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.agentSessions.sideChat';
	static readonly EDITOR_ID = 'workbench.editor.agentSessions.sideChat';

	override get resource(): URI | undefined {
		return undefined;
	}

	override get typeId(): string {
		return SideChatEditorInput.ID;
	}

	override get editorId(): string {
		return SideChatEditorInput.EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('sideChatEditor.name', "Side Chat");
	}

	override getIcon(): ThemeIcon {
		return Codicon.commentDiscussion;
	}

	override getTitle(_verbosity?: Verbosity): string {
		return this.getName();
	}

	override canReopen(): boolean {
		return true;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof SideChatEditorInput;
	}
}

export class SideChatEditorSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): editorInput is SideChatEditorInput {
		return editorInput instanceof SideChatEditorInput;
	}

	serialize(editorInput: EditorInput): string | undefined {
		return this.canSerialize(editorInput) ? '' : undefined;
	}

	deserialize(instantiationService: IInstantiationService, _serializedEditor: string): EditorInput {
		return instantiationService.createInstance(SideChatEditorInput);
	}
}
