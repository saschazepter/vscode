/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../../common/editor.js';
import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { IPromptsService } from '../../../common/promptSyntax/service/promptsService.js';
import { PromptsType } from '../../../common/promptSyntax/promptTypes.js';
import { ParsedPromptFile, PromptFileParser } from '../../../common/promptSyntax/promptFileParser.js';
import { AI_CUSTOMIZATION_EDITOR_ID, AI_CUSTOMIZATION_EDITOR_VIEW_TYPE } from '../aiCustomizationEditor.js';
import { agentIcon, instructionsIcon, promptIcon, skillIcon } from '../../aiCustomizationTreeView/aiCustomizationTreeViewIcons.js';

/**
 * Determines the PromptsType from a file URI based on its extension/name.
 */
export function getPromptTypeFromURI(uri: URI): PromptsType {
	const path = uri.path.toLowerCase();
	if (path.endsWith('.agent.md')) {
		return PromptsType.agent;
	} else if (path.endsWith('.instructions.md')) {
		return PromptsType.instructions;
	} else if (path.endsWith('.prompt.md')) {
		return PromptsType.prompt;
	} else if (path.endsWith('skill.md')) {
		return PromptsType.skill;
	}
	// Default to prompt
	return PromptsType.prompt;
}

/**
 * Gets the appropriate icon for a prompt type.
 */
export function getIconForPromptType(type: PromptsType): ThemeIcon {
	switch (type) {
		case PromptsType.agent:
			return agentIcon;
		case PromptsType.skill:
			return skillIcon;
		case PromptsType.instructions:
			return instructionsIcon;
		case PromptsType.prompt:
		default:
			return promptIcon;
	}
}

/**
 * Model for an AI Customization file (agent, skill, instructions, prompt).
 * Tracks the parsed state and dirty state of the file.
 */
export class AICustomizationEditorModel extends Disposable {
	private _parsed: ParsedPromptFile | undefined;
	private _content: string = '';
	private _dirty = false;

	private readonly _onDidChangeContent = this._register(new Emitter<void>());
	readonly onDidChangeContent: Event<void> = this._onDidChangeContent.event;

	private readonly _onDidChangeDirty = this._register(new Emitter<void>());
	readonly onDidChangeDirty: Event<void> = this._onDidChangeDirty.event;

	private readonly parser = new PromptFileParser();

	constructor(
		readonly uri: URI,
		readonly promptType: PromptsType,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
	}

	get parsed(): ParsedPromptFile | undefined {
		return this._parsed;
	}

	get content(): string {
		return this._content;
	}

	get isDirty(): boolean {
		return this._dirty;
	}

	/**
	 * Loads the file content and parses it.
	 */
	async load(): Promise<void> {
		const stat = await this.fileService.readFile(this.uri);
		this._content = stat.value.toString();
		this._parsed = this.parser.parse(this.uri, this._content);
		this._dirty = false;
		this._onDidChangeContent.fire();
	}

	/**
	 * Updates the content and re-parses it.
	 */
	updateContent(content: string): void {
		if (this._content === content) {
			return;
		}
		this._content = content;
		this._parsed = this.parser.parse(this.uri, this._content);
		const wasDirty = this._dirty;
		this._dirty = true;
		this._onDidChangeContent.fire();
		if (!wasDirty) {
			this._onDidChangeDirty.fire();
		}
	}

	/**
	 * Saves the file content.
	 */
	async save(): Promise<void> {
		await this.fileService.writeFile(this.uri, VSBuffer.fromString(this._content));
		const wasDirty = this._dirty;
		this._dirty = false;
		if (wasDirty) {
			this._onDidChangeDirty.fire();
		}
	}

	/**
	 * Reverts to the saved file content.
	 */
	async revert(): Promise<void> {
		await this.load();
	}

	//#region Frontmatter helpers

	/**
	 * Gets the name from frontmatter, or derives it from the filename.
	 */
	getName(): string {
		return this._parsed?.header?.name ?? basename(this.uri).replace(/\.(agent|skill|instructions|prompt)\.md$/i, '');
	}

	/**
	 * Gets the description from frontmatter.
	 */
	getDescription(): string | undefined {
		return this._parsed?.header?.description;
	}

	/**
	 * Gets the model(s) from frontmatter.
	 */
	getModel(): readonly string[] | undefined {
		return this._parsed?.header?.model;
	}

	/**
	 * Gets the tools from frontmatter.
	 */
	getTools(): string[] | undefined {
		return this._parsed?.header?.tools;
	}

	/**
	 * Gets the applyTo glob from frontmatter (for instructions).
	 */
	getApplyTo(): string | undefined {
		return this._parsed?.header?.applyTo;
	}

	/**
	 * Gets the body content (instructions/content text).
	 */
	getBody(): string {
		if (!this._parsed?.body) {
			// No body parsed, return content after frontmatter or empty
			const frontmatterEnd = this._content.indexOf('---', 4);
			if (frontmatterEnd > 0) {
				const afterFrontmatter = this._content.indexOf('\n', frontmatterEnd);
				if (afterFrontmatter > 0) {
					return this._content.substring(afterFrontmatter + 1).trim();
				}
			}
			return this._content;
		}
		// Extract body text from content using range
		const lines = this._content.split('\n');
		const bodyLines = lines.slice(this._parsed.body.range.startLineNumber - 1, this._parsed.body.range.endLineNumber - 1);
		return bodyLines.join('\n').trim();
	}

	//#endregion
}

/**
 * Editor input for AI Customization files (agents, skills, instructions, prompts).
 * Opens files in the form-based AI Customization Editor.
 */
export class AICustomizationEditorInput extends EditorInput {
	static readonly ID = AI_CUSTOMIZATION_EDITOR_ID;

	private _model: AICustomizationEditorModel | undefined;
	private readonly promptType: PromptsType;

	constructor(
		readonly resource: URI,
		@IFileService private readonly fileService: IFileService,
		@IPromptsService _promptsService: IPromptsService,
	) {
		super();
		this.promptType = getPromptTypeFromURI(resource);
	}

	override get typeId(): string {
		return AICustomizationEditorInput.ID;
	}

	override get editorId(): string {
		return AI_CUSTOMIZATION_EDITOR_VIEW_TYPE;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return basename(this.resource);
	}

	override getTitle(): string {
		const typeName = this.getPromptTypeName();
		return localize('aiCustomizationEditorTitle', "{0} - {1}", this.getName(), typeName);
	}

	override getIcon(): ThemeIcon {
		return getIconForPromptType(this.promptType);
	}

	override isDirty(): boolean {
		return this._model?.isDirty ?? false;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(otherInput)) {
			return true;
		}
		if (otherInput instanceof AICustomizationEditorInput) {
			return this.resource.toString() === otherInput.resource.toString();
		}
		return false;
	}

	override async resolve(): Promise<AICustomizationEditorModel> {
		if (!this._model) {
			this._model = this._register(new AICustomizationEditorModel(
				this.resource,
				this.promptType,
				this.fileService,
			));
			this._register(this._model.onDidChangeDirty(() => this._onDidChangeDirty.fire()));
			await this._model.load();
		}
		return this._model;
	}

	override async save(): Promise<EditorInput | undefined> {
		await this._model?.save();
		return this;
	}

	override async revert(): Promise<void> {
		await this._model?.revert();
	}

	getPromptType(): PromptsType {
		return this.promptType;
	}

	private getPromptTypeName(): string {
		switch (this.promptType) {
			case PromptsType.agent:
				return localize('agent', "Agent");
			case PromptsType.skill:
				return localize('skill', "Skill");
			case PromptsType.instructions:
				return localize('instructions', "Instructions");
			case PromptsType.prompt:
			default:
				return localize('prompt', "Prompt");
		}
	}
}
