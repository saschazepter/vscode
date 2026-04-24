/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IChatEditorOptions } from '../../../../workbench/contrib/chat/browser/widgetHosts/editor/chatEditor.js';
import { ChatEditorInput } from '../../../../workbench/contrib/chat/browser/widgetHosts/editor/chatEditorInput.js';
import { NewChatWidget } from './newChatViewPane.js';

export const NEW_CHAT_EDITOR_ID = 'workbench.editor.sessions.newChat';

export class NewChatEditorInput extends EditorInput {

	static readonly ID = NEW_CHAT_EDITOR_ID;

	readonly resource = undefined;

	private static instance: NewChatEditorInput | undefined;

	static getOrCreate(): NewChatEditorInput {
		if (!NewChatEditorInput.instance || NewChatEditorInput.instance.isDisposed()) {
			NewChatEditorInput.instance = new NewChatEditorInput();
		}
		return NewChatEditorInput.instance;
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton | EditorInputCapabilities.ForceReveal;
	}

	override get typeId(): string {
		return NewChatEditorInput.ID;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof NewChatEditorInput;
	}

	override getName(): string {
		return localize('sessionsNewChatEditorName', "New Session");
	}

	override getIcon(): ThemeIcon {
		return Codicon.chatSparkle;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}

export class NewChatEditor extends EditorPane {

	static readonly ID = NEW_CHAT_EDITOR_ID;

	private container: HTMLElement | undefined;
	private widget: NewChatWidget | undefined;
	private dimension: dom.Dimension | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(NewChatEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, dom.$('.sessions-new-chat-editor'));
		this.widget = this._register(this.instantiationService.createInstance(NewChatWidget));
		this._register(this.widget.onDidCreateChat(chat => this.replaceWithChatEditor(chat.resource)));
		this.widget.render(this.container);
	}

	private async replaceWithChatEditor(resource: URI): Promise<void> {
		if (!(this.input instanceof NewChatEditorInput)) {
			return;
		}

		await this.editorService.replaceEditors([{
			editor: this.input,
			replacement: {
				resource,
				options: {
					override: ChatEditorInput.EditorID,
					pinned: true,
				} satisfies IChatEditorOptions,
			}
		}], this.group);
	}

	override async setInput(input: NewChatEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override layout(dimension: dom.Dimension): void {
		this.dimension = dimension;
		this.widget?.layout(dimension.height, dimension.width);
	}

	override focus(): void {
		super.focus();
		this.widget?.focusInput();
	}

	override clearInput(): void {
		this.widget?.saveState();
		super.clearInput();
	}

	override dispose(): void {
		this.widget?.saveState();
		super.dispose();
	}
}
