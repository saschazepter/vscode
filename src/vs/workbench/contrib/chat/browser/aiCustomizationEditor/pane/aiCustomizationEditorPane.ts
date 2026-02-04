/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/aiCustomizationEditor.css';
import * as DOM from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { Orientation, Sizing, SplitView } from '../../../../../../base/browser/ui/splitview/splitview.js';
import { DomScrollableElement } from '../../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollbarVisibility } from '../../../../../../base/common/scrollable.js';
import { localize } from '../../../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../../common/editor.js';
import { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { AICustomizationEditorInput, AICustomizationEditorModel } from '../input/aiCustomizationEditorInput.js';
import {
	AI_CUSTOMIZATION_EDITOR_ID,
	AI_CUSTOMIZATION_EDITOR_TOC_WIDTH_KEY,
	EDITOR_MIN_WIDTH,
	NARROW_THRESHOLD,
	TOC_DEFAULT_WIDTH,
	TOC_MIN_WIDTH,
} from '../aiCustomizationEditor.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { settingsSashBorder } from '../../../../preferences/common/settingsEditorColorRegistry.js';
import { WorkbenchAsyncDataTree } from '../../../../../../platform/list/browser/listService.js';
import { IAsyncDataSource, ITreeNode, ITreeRenderer } from '../../../../../../base/browser/ui/tree/tree.js';
import { FuzzyScore } from '../../../../../../base/common/filters.js';
import { IListVirtualDelegate } from '../../../../../../base/browser/ui/list/list.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { PromptsType } from '../../../common/promptSyntax/promptTypes.js';
import { agentIcon, instructionsIcon, promptIcon, skillIcon } from '../../aiCustomizationTreeView/aiCustomizationTreeViewIcons.js';
import { PromptHeaderAttributes } from '../../../common/promptSyntax/promptFileParser.js';
import { FieldValue, IFieldDefinition, ISectionDefinition, SectionRenderer } from '../fields/fieldRenderers.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';

const $ = DOM.$;

//#region TOC Tree Types

/**
 * Root element marker for the TOC tree.
 */
const TOC_ROOT = Symbol('tocRoot');
type TocRootElement = typeof TOC_ROOT;

/**
 * Represents a section in the TOC (e.g., "Overview", "Behavior", "Tools").
 */
interface ITocSectionItem {
	readonly type: 'section';
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
}

type TocTreeItem = ITocSectionItem;

//#endregion

//#region TOC Tree Infrastructure

class TocTreeDelegate implements IListVirtualDelegate<TocTreeItem> {
	getHeight(): number {
		return 22;
	}

	getTemplateId(): string {
		return 'tocSection';
	}
}

interface ITocSectionTemplateData {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
}

class TocSectionRenderer implements ITreeRenderer<ITocSectionItem, FuzzyScore, ITocSectionTemplateData> {
	readonly templateId = 'tocSection';

	renderTemplate(container: HTMLElement): ITocSectionTemplateData {
		const element = DOM.append(container, $('.ai-customization-toc-section'));
		const icon = DOM.append(element, $('.icon'));
		const label = DOM.append(element, $('.label'));
		return { container: element, icon, label };
	}

	renderElement(node: ITreeNode<ITocSectionItem, FuzzyScore>, _index: number, templateData: ITocSectionTemplateData): void {
		templateData.icon.className = 'icon';
		templateData.icon.classList.add(...ThemeIcon.asClassNameArray(node.element.icon));
		templateData.label.textContent = node.element.label;
	}

	disposeTemplate(): void { }
}

/**
 * Data source for the TOC tree. Provides section items based on the prompt type.
 */
class TocDataSource implements IAsyncDataSource<TocRootElement, TocTreeItem> {
	private promptType: PromptsType = PromptsType.prompt;

	setPromptType(type: PromptsType): void {
		this.promptType = type;
	}

	hasChildren(element: TocRootElement | TocTreeItem): boolean {
		return element === TOC_ROOT;
	}

	async getChildren(element: TocRootElement | TocTreeItem): Promise<TocTreeItem[]> {
		if (element !== TOC_ROOT) {
			return [];
		}

		return this.getSectionsForType(this.promptType);
	}

	private getSectionsForType(type: PromptsType): ITocSectionItem[] {
		const common: ITocSectionItem[] = [
			{
				type: 'section',
				id: 'overview',
				label: localize('overview', "Overview"),
				icon: this.getIconForType(type),
			},
		];

		switch (type) {
			case PromptsType.agent:
				return [
					...common,
					{
						type: 'section',
						id: 'behavior',
						label: localize('behavior', "Behavior"),
						icon: agentIcon,
					},
					{
						type: 'section',
						id: 'model',
						label: localize('model', "Model"),
						icon: agentIcon,
					},
					{
						type: 'section',
						id: 'tools',
						label: localize('tools', "Tools"),
						icon: agentIcon,
					},
				];

			case PromptsType.skill:
				return [
					...common,
					{
						type: 'section',
						id: 'behavior',
						label: localize('behavior', "Behavior"),
						icon: skillIcon,
					},
					{
						type: 'section',
						id: 'tools',
						label: localize('tools', "Tools"),
						icon: skillIcon,
					},
				];

			case PromptsType.instructions:
				return [
					...common,
					{
						type: 'section',
						id: 'content',
						label: localize('content', "Content"),
						icon: instructionsIcon,
					},
					{
						type: 'section',
						id: 'applyTo',
						label: localize('applyTo', "Apply To"),
						icon: instructionsIcon,
					},
				];

			case PromptsType.prompt:
			default:
				return [
					...common,
					{
						type: 'section',
						id: 'content',
						label: localize('content', "Content"),
						icon: promptIcon,
					},
				];
		}
	}

	private getIconForType(type: PromptsType): ThemeIcon {
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
}

//#endregion

//#region Field Definitions

function getFieldDefinitionsForType(type: PromptsType): ISectionDefinition[] {
	const overviewFields: IFieldDefinition[] = [
		{
			id: 'name',
			key: PromptHeaderAttributes.name,
			label: localize('name', "Name"),
			description: localize('nameDescription', "A unique name for this customization"),
			type: 'text',
			placeholder: localize('namePlaceholder', "Enter a name..."),
			required: true,
		},
		{
			id: 'description',
			key: PromptHeaderAttributes.description,
			label: localize('description', "Description"),
			description: localize('descriptionDescription', "A brief description of what this does"),
			type: 'text',
			placeholder: localize('descriptionPlaceholder', "Enter a description..."),
		},
	];

	const behaviorFields: IFieldDefinition[] = [
		{
			id: 'instructions',
			key: 'body',
			label: localize('instructions', "Instructions"),
			description: localize('instructionsDescription', "The main instructions or content"),
			type: 'multiline',
			placeholder: localize('instructionsPlaceholder', "Enter instructions..."),
		},
	];

	const modelFields: IFieldDefinition[] = [
		{
			id: 'model',
			key: PromptHeaderAttributes.model,
			label: localize('model', "Model"),
			description: localize('modelDescription', "The language model(s) to use"),
			type: 'array',
			placeholder: localize('modelPlaceholder', "e.g., gpt-4o, claude-3-5-sonnet"),
		},
	];

	const toolsFields: IFieldDefinition[] = [
		{
			id: 'tools',
			key: PromptHeaderAttributes.tools,
			label: localize('tools', "Tools"),
			description: localize('toolsDescription', "Tools that this customization can use"),
			type: 'array',
			placeholder: localize('toolsPlaceholder', "e.g., search, file_read"),
		},
	];

	const applyToFields: IFieldDefinition[] = [
		{
			id: 'applyTo',
			key: PromptHeaderAttributes.applyTo,
			label: localize('applyTo', "Apply To"),
			description: localize('applyToDescription', "Glob pattern for files these instructions apply to"),
			type: 'text',
			placeholder: localize('applyToPlaceholder', "e.g., **/*.ts, src/**"),
		},
	];

	function getIconForType(t: PromptsType): ThemeIcon {
		switch (t) {
			case PromptsType.agent: return agentIcon;
			case PromptsType.skill: return skillIcon;
			case PromptsType.instructions: return instructionsIcon;
			default: return promptIcon;
		}
	}

	const icon = getIconForType(type);

	switch (type) {
		case PromptsType.agent:
			return [
				{ id: 'overview', label: localize('overview', "Overview"), icon, fields: overviewFields },
				{ id: 'behavior', label: localize('behavior', "Behavior"), icon, fields: behaviorFields },
				{ id: 'model', label: localize('model', "Model"), icon, fields: modelFields },
				{ id: 'tools', label: localize('tools', "Tools"), icon, fields: toolsFields },
			];

		case PromptsType.skill:
			return [
				{ id: 'overview', label: localize('overview', "Overview"), icon, fields: overviewFields },
				{ id: 'behavior', label: localize('behavior', "Behavior"), icon, fields: behaviorFields },
				{ id: 'tools', label: localize('tools', "Tools"), icon, fields: toolsFields },
			];

		case PromptsType.instructions:
			return [
				{ id: 'overview', label: localize('overview', "Overview"), icon, fields: overviewFields },
				{ id: 'content', label: localize('content', "Content"), icon, fields: behaviorFields },
				{ id: 'applyTo', label: localize('applyTo', "Apply To"), icon, fields: applyToFields },
			];

		case PromptsType.prompt:
		default:
			return [
				{ id: 'overview', label: localize('overview', "Overview"), icon, fields: overviewFields },
				{ id: 'content', label: localize('content', "Content"), icon, fields: behaviorFields },
			];
	}
}

//#endregion

/**
 * Editor pane for AI Customization files (agents, skills, instructions, prompts).
 * Provides a form-based UI with a TOC sidebar similar to the Settings Editor.
 */
export class AICustomizationEditorPane extends EditorPane {
	static readonly ID = AI_CUSTOMIZATION_EDITOR_ID;

	private rootElement!: HTMLElement;
	private headerContainer!: HTMLElement;
	private titleElement!: HTMLElement;
	private toolbarContainer!: HTMLElement;
	private bodyContainer!: HTMLElement;
	private tocTreeContainer!: HTMLElement;
	private editorContainer!: HTMLElement;
	private editorScrollable!: DomScrollableElement;
	private editorContent!: HTMLElement;

	private splitView: SplitView<number> | undefined;
	private tocTree: WorkbenchAsyncDataTree<TocRootElement, TocTreeItem, FuzzyScore> | undefined;
	private tocDataSource: TocDataSource | undefined;
	private saveButton: Button | undefined;
	private revertButton: Button | undefined;

	private model: AICustomizationEditorModel | undefined;

	private readonly sectionRenderers = new Map<string, SectionRenderer>();
	private readonly modelDisposables = this._register(new DisposableStore());
	private readonly fieldDisposables = this._register(new DisposableStore());
	private readonly inputChangeDisposable = this._register(new MutableDisposable());
	private readonly _onDidChangeDirty = this._register(new Emitter<void>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super(AICustomizationEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.setAttribute('tabindex', '-1');
		this.rootElement = DOM.append(parent, $('.ai-customization-editor', { tabindex: '-1' }));

		this.createHeader(this.rootElement);
		this.createBody(this.rootElement);
	}

	private createHeader(parent: HTMLElement): void {
		this.headerContainer = DOM.append(parent, $('.ai-customization-header'));

		// Title
		this.titleElement = DOM.append(this.headerContainer, $('.title'));
		this.titleElement.textContent = localize('aiCustomizationEditor', "AI Customization Editor");

		// Toolbar
		this.toolbarContainer = DOM.append(this.headerContainer, $('.toolbar'));

		// Save button
		this.saveButton = this._register(new Button(this.toolbarContainer, {
			title: localize('save', "Save"),
			...defaultButtonStyles,
		}));
		this.saveButton.icon = Codicon.save;
		this.saveButton.element.classList.add('monaco-icon-button');

		this._register(this.saveButton.onDidClick(async () => {
			await this.model?.save();
			this.updateToolbarState();
		}));

		// Revert button
		this.revertButton = this._register(new Button(this.toolbarContainer, {
			title: localize('revert', "Revert"),
			secondary: true,
			...defaultButtonStyles,
		}));
		this.revertButton.icon = Codicon.discard;
		this.revertButton.element.classList.add('monaco-icon-button');

		this._register(this.revertButton.onDidClick(async () => {
			await this.model?.revert();
			this.refreshFieldValues();
			this.updateToolbarState();
		}));

		this.updateToolbarState();
	}

	private createBody(parent: HTMLElement): void {
		this.bodyContainer = DOM.append(parent, $('.ai-customization-body'));

		this.tocTreeContainer = $('.ai-customization-toc-container');
		this.editorContainer = $('.ai-customization-editor-container');

		this.createTOC(this.tocTreeContainer);
		this.createFieldEditor(this.editorContainer);

		this.splitView = this._register(new SplitView<number>(this.bodyContainer, {
			orientation: Orientation.HORIZONTAL,
			proportionalLayout: true,
		}));

		const startingWidth = this.storageService.getNumber(AI_CUSTOMIZATION_EDITOR_TOC_WIDTH_KEY, StorageScope.PROFILE, TOC_DEFAULT_WIDTH);

		// TOC view (left)
		this.splitView.addView({
			onDidChange: Event.None,
			element: this.tocTreeContainer,
			minimumSize: TOC_MIN_WIDTH,
			maximumSize: Number.POSITIVE_INFINITY,
			layout: (width, _, height) => {
				this.tocTreeContainer.style.width = `${width}px`;
				this.tocTree?.layout(height, width);
			},
		}, startingWidth, undefined, true);

		// Field editor view (right)
		this.splitView.addView({
			onDidChange: Event.None,
			element: this.editorContainer,
			minimumSize: EDITOR_MIN_WIDTH,
			maximumSize: Number.POSITIVE_INFINITY,
			layout: (width, _, height) => {
				this.editorContainer.style.width = `${width}px`;
				this.editorScrollable.scanDomNode();
			},
		}, Sizing.Distribute, undefined, true);

		// Handle sash reset (double-click)
		this._register(this.splitView.onDidSashReset(() => {
			const totalSize = this.splitView!.getViewSize(0) + this.splitView!.getViewSize(1);
			this.splitView!.resizeView(0, TOC_DEFAULT_WIDTH);
			this.splitView!.resizeView(1, totalSize - TOC_DEFAULT_WIDTH);
		}));

		// Persist TOC width on sash change
		this._register(this.splitView.onDidSashChange(() => {
			const width = this.splitView!.getViewSize(0);
			this.storageService.store(AI_CUSTOMIZATION_EDITOR_TOC_WIDTH_KEY, width, StorageScope.PROFILE, StorageTarget.USER);
		}));

		// Style the sash
		const borderColor = this.themeService.getColorTheme().getColor(settingsSashBorder);
		if (borderColor) {
			this.splitView.style({ separatorBorder: borderColor });
		}
	}

	private createTOC(container: HTMLElement): void {
		this.tocDataSource = new TocDataSource();

		this.tocTree = this._register(this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<TocRootElement, TocTreeItem, FuzzyScore>,
			'AICustomizationEditorTOC',
			container,
			new TocTreeDelegate(),
			[new TocSectionRenderer()],
			this.tocDataSource,
			{
				identityProvider: {
					getId: (element: TocTreeItem) => element.id,
				},
				accessibilityProvider: {
					getAriaLabel: (element: TocTreeItem) => element.label,
					getWidgetAriaLabel: () => localize('tocTree', "Table of Contents"),
				},
			}
		));

		// Handle TOC selection
		this._register(this.tocTree.onDidChangeSelection(e => {
			const element = e.elements[0];
			if (element) {
				this.scrollToSection(element.id);
			}
		}));
	}

	private createFieldEditor(container: HTMLElement): void {
		// Create scrollable content area
		this.editorContent = $('.ai-customization-field-content');

		this.editorScrollable = this._register(new DomScrollableElement(this.editorContent, {
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
		}));

		container.appendChild(this.editorScrollable.getDomNode());
	}

	private renderSections(promptType: PromptsType): void {
		// Clear existing sections
		this.clearSections();

		const sections = getFieldDefinitionsForType(promptType);
		const options = {
			contextViewService: this.contextViewService,
			hoverService: this.hoverService,
		};

		for (const sectionDef of sections) {
			const renderer = new SectionRenderer(sectionDef, options);
			this.fieldDisposables.add(renderer);
			this.sectionRenderers.set(sectionDef.id, renderer);

			renderer.render(this.editorContent);

			this.fieldDisposables.add(renderer.onDidChange(e => {
				this.handleFieldChange(e.fieldId, e.value);
			}));
		}

		this.editorScrollable.scanDomNode();
	}

	private clearSections(): void {
		this.fieldDisposables.clear();
		this.sectionRenderers.clear();
		DOM.clearNode(this.editorContent);
	}

	private scrollToSection(sectionId: string): void {
		const renderer = this.sectionRenderers.get(sectionId);
		if (renderer) {
			const element = renderer.getElement();
			if (element) {
				element.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
		}
	}

	private handleFieldChange(fieldId: string, value: FieldValue): void {
		if (!this.model) {
			return;
		}

		// Update the model content based on field changes
		// This is a simplified implementation - a full implementation would
		// properly serialize frontmatter and body
		const parsed = this.model.parsed;
		if (!parsed) {
			return;
		}

		// For now, just mark the model as dirty by updating content
		// A proper implementation would rebuild the frontmatter + body
		const currentContent = this.model.content;
		if (fieldId === 'instructions' && typeof value === 'string') {
			// Update body content
			const frontmatterEnd = currentContent.indexOf('---', 4);
			if (frontmatterEnd > 0) {
				const frontmatter = currentContent.substring(0, frontmatterEnd + 3);
				this.model.updateContent(frontmatter + '\n\n' + value);
			}
		}

		this.updateToolbarState();
	}

	private refreshFieldValues(): void {
		if (!this.model) {
			return;
		}

		// Set overview fields
		const overviewRenderer = this.sectionRenderers.get('overview');
		if (overviewRenderer) {
			overviewRenderer.setFieldValue('name', this.model.getName());
			overviewRenderer.setFieldValue('description', this.model.getDescription());
		}

		// Set behavior/content fields
		const behaviorRenderer = this.sectionRenderers.get('behavior') ?? this.sectionRenderers.get('content');
		if (behaviorRenderer) {
			behaviorRenderer.setFieldValue('instructions', this.model.getBody());
		}

		// Set model fields (for agents)
		const modelRenderer = this.sectionRenderers.get('model');
		if (modelRenderer) {
			const models = this.model.getModel();
			modelRenderer.setFieldValue('model', models ? [...models] : undefined);
		}

		// Set tools fields (for agents/skills)
		const toolsRenderer = this.sectionRenderers.get('tools');
		if (toolsRenderer) {
			toolsRenderer.setFieldValue('tools', this.model.getTools());
		}

		// Set applyTo field (for instructions)
		const applyToRenderer = this.sectionRenderers.get('applyTo');
		if (applyToRenderer) {
			applyToRenderer.setFieldValue('applyTo', this.model.getApplyTo());
		}
	}

	private updateToolbarState(): void {
		const isDirty = this.model?.isDirty ?? false;
		this.saveButton?.element.classList.toggle('disabled', !isDirty);
		this.revertButton?.element.classList.toggle('disabled', !isDirty);
	}

	private updateHeader(): void {
		if (!this.model || !this.titleElement) {
			return;
		}

		this.titleElement.textContent = this.model.getName();
	}

	override async setInput(input: AICustomizationEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!this.input) {
			return;
		}

		// Resolve the model
		const model = await input.resolve();
		if (token.isCancellationRequested) {
			return;
		}

		this.modelDisposables.clear();
		this.model = model;

		// Update TOC for the prompt type
		const promptType = input.getPromptType();
		this.tocDataSource?.setPromptType(promptType);
		await this.tocTree?.setInput(TOC_ROOT);

		// Render sections for this prompt type
		this.renderSections(promptType);

		// Update header
		this.updateHeader();

		// Populate field values
		this.refreshFieldValues();

		// Listen for model changes
		this.modelDisposables.add(model.onDidChangeContent(() => {
			this.refreshFieldValues();
			this.updateHeader();
		}));

		this.modelDisposables.add(model.onDidChangeDirty(() => {
			this._onDidChangeDirty.fire();
			this.updateToolbarState();
		}));

		// Handle input disposal
		this.inputChangeDisposable.value = input.onWillDispose(() => {
			this.clearInput();
		});

		this.updateToolbarState();
	}

	override clearInput(): void {
		this.modelDisposables.clear();
		this.clearSections();
		this.model = undefined;
		super.clearInput();
	}

	layout(dimension: DOM.Dimension): void {
		if (!this.isVisible()) {
			return;
		}

		this.rootElement.style.width = `${dimension.width}px`;
		this.rootElement.style.height = `${dimension.height}px`;

		// Calculate header height
		const headerHeight = this.headerContainer?.offsetHeight ?? 40;
		const bodyHeight = dimension.height - headerHeight;

		this.bodyContainer.style.height = `${bodyHeight}px`;
		this.splitView?.layout(dimension.width, bodyHeight);

		// Toggle narrow mode
		this.rootElement.classList.toggle('narrow-width', dimension.width < NARROW_THRESHOLD);
	}

	override focus(): void {
		super.focus();
		this.tocTree?.domFocus();
	}
}

//#endregion
