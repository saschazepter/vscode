/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationManagement.css';
import * as DOM from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, IReference, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { Orientation, Sizing, SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { SnippetController2 } from '../../../../editor/contrib/snippet/browser/snippetController2.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { getSimpleEditorOptions } from '../../../contrib/codeEditor/browser/simpleEditorOptions.js';
import { localize } from '../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { IListVirtualDelegate, IListRenderer } from '../../../../base/browser/ui/list/list.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { PANEL_BORDER } from '../../../common/theme.js';
import { AICustomizationManagementEditorInput } from './aiCustomizationManagementEditorInput.js';
import { AICustomizationListWidget, IAICustomizationListItem } from './aiCustomizationListWidget.js';
import { McpListWidget } from './mcpListWidget.js';
import {
	AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID,
	AI_CUSTOMIZATION_MANAGEMENT_SIDEBAR_WIDTH_KEY,
	AI_CUSTOMIZATION_MANAGEMENT_SELECTED_SECTION_KEY,
	AICustomizationManagementSection,
	CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_EDITOR,
	CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_SECTION,
	SIDEBAR_DEFAULT_WIDTH,
	SIDEBAR_MIN_WIDTH,
	SIDEBAR_MAX_WIDTH,
	CONTENT_MIN_WIDTH,
} from './aiCustomizationManagement.js';
import { agentIcon, instructionsIcon, promptIcon, skillIcon, hookIcon } from '../aiCustomizationTreeView/aiCustomizationTreeViewIcons.js';
import { ChatModelsWidget } from '../../../contrib/chat/browser/chatManagement/chatModelsWidget.js';
import { PromptsType } from '../../../contrib/chat/common/promptSyntax/promptTypes.js';
import { PromptsStorage } from '../../../contrib/chat/common/promptSyntax/service/promptsService.js';
import { getCleanPromptName, SKILL_FILENAME, getPromptFileExtension } from '../../../contrib/chat/common/promptSyntax/config/promptFileLocations.js';
import { getDefaultContentSnippet } from '../../../contrib/chat/browser/promptSyntax/newPromptFileActions.js';
import { askForPromptSourceFolder } from '../../../contrib/chat/browser/promptSyntax/pickers/askForPromptSourceFolder.js';
import { CustomizationCreatorService } from './customizationCreatorService.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { getActiveWorkingDirectory } from '../agentSessionUtils.js';
import { ISCMService } from '../../../contrib/scm/common/scm.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

const $ = DOM.$;

export const aiCustomizationManagementSashBorder = registerColor(
	'aiCustomizationManagement.sashBorder',
	PANEL_BORDER,
	localize('aiCustomizationManagementSashBorder', "The color of the AI Customization Management editor splitview sash border.")
);

//#region Sidebar Section Item

interface ISectionItem {
	readonly id: AICustomizationManagementSection;
	readonly label: string;
	readonly icon: ThemeIcon;
}

class SectionItemDelegate implements IListVirtualDelegate<ISectionItem> {
	getHeight(): number {
		return 26;
	}

	getTemplateId(): string {
		return 'sectionItem';
	}
}

interface ISectionItemTemplateData {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
}

class SectionItemRenderer implements IListRenderer<ISectionItem, ISectionItemTemplateData> {
	readonly templateId = 'sectionItem';

	renderTemplate(container: HTMLElement): ISectionItemTemplateData {
		container.classList.add('section-list-item');
		const icon = DOM.append(container, $('.section-icon'));
		const label = DOM.append(container, $('.section-label'));
		return { container, icon, label };
	}

	renderElement(element: ISectionItem, index: number, templateData: ISectionItemTemplateData): void {
		templateData.icon.className = 'section-icon';
		templateData.icon.classList.add(...ThemeIcon.asClassNameArray(element.icon));
		templateData.label.textContent = element.label;
	}

	disposeTemplate(): void { }
}

//#endregion

/**
 * Editor pane for the AI Customizations Management Editor.
 * Provides a global view of all AI customizations with a sidebar for navigation
 * and a content area showing a searchable list of items.
 */
export class AICustomizationManagementEditor extends EditorPane {

	static readonly ID = AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID;

	private container!: HTMLElement;
	private splitViewContainer!: HTMLElement;
	private splitView!: SplitView<number>;
	private sidebarContainer!: HTMLElement;
	private sectionsList!: WorkbenchList<ISectionItem>;
	private contentContainer!: HTMLElement;
	private listWidget!: AICustomizationListWidget;
	private mcpListWidget!: McpListWidget;
	private modelsWidget!: ChatModelsWidget;
	private promptsContentContainer!: HTMLElement;
	private mcpContentContainer!: HTMLElement;
	private modelsContentContainer!: HTMLElement;
	private modelsFooterElement!: HTMLElement;

	// Embedded editor state
	private editorContentContainer!: HTMLElement;
	private embeddedEditorContainer!: HTMLElement;
	private embeddedEditor!: CodeEditorWidget;
	private editorItemNameElement!: HTMLElement;
	private editorItemPathElement!: HTMLElement;
	private commitButton!: Button;
	private currentEditingUri: URI | undefined;
	private currentModelRef: IReference<IResolvedTextEditorModel> | undefined;
	private viewMode: 'list' | 'editor' = 'list';

	private dimension: DOM.Dimension | undefined;
	private readonly sections: ISectionItem[] = [];
	private selectedSection: AICustomizationManagementSection = AICustomizationManagementSection.Agents;

	private readonly editorDisposables = this._register(new DisposableStore());
	private readonly inputDisposables = this._register(new MutableDisposable());
	private readonly customizationCreator: CustomizationCreatorService;

	private readonly inEditorContextKey: IContextKey<boolean>;
	private readonly sectionContextKey: IContextKey<string>;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ISCMService private readonly scmService: ISCMService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(AICustomizationManagementEditor.ID, group, telemetryService, themeService, storageService);

		this.inEditorContextKey = CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_EDITOR.bindTo(contextKeyService);
		this.sectionContextKey = CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_SECTION.bindTo(contextKeyService);

		this.customizationCreator = this.instantiationService.createInstance(CustomizationCreatorService);

		// Safety disposal for the embedded editor model reference
		this._register(toDisposable(() => {
			this.currentModelRef?.dispose();
			this.currentModelRef = undefined;
		}));

		this.sections.push(
			{ id: AICustomizationManagementSection.Agents, label: localize('agents', "Agents"), icon: agentIcon },
			{ id: AICustomizationManagementSection.Skills, label: localize('skills', "Skills"), icon: skillIcon },
			{ id: AICustomizationManagementSection.Instructions, label: localize('instructions', "Instructions"), icon: instructionsIcon },
			{ id: AICustomizationManagementSection.Prompts, label: localize('prompts', "Prompts"), icon: promptIcon },
			{ id: AICustomizationManagementSection.Hooks, label: localize('hooks', "Hooks"), icon: hookIcon },
			{ id: AICustomizationManagementSection.McpServers, label: localize('mcpServers', "MCP Servers"), icon: Codicon.server },
			{ id: AICustomizationManagementSection.Models, label: localize('models', "Models"), icon: Codicon.vm },
		);

		// Restore selected section from storage
		const savedSection = this.storageService.get(AI_CUSTOMIZATION_MANAGEMENT_SELECTED_SECTION_KEY, StorageScope.PROFILE);
		if (savedSection && Object.values(AICustomizationManagementSection).includes(savedSection as AICustomizationManagementSection)) {
			this.selectedSection = savedSection as AICustomizationManagementSection;
		}

		// Eagerly open the worktree as a git repository so it's ready for commits
		this.ensureWorktreeRepository();
	}

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		this.container = DOM.append(parent, $('.ai-customization-management-editor'));

		this.createSplitView();
		this.updateStyles();
	}

	private createSplitView(): void {
		this.splitViewContainer = DOM.append(this.container, $('.management-split-view'));

		this.sidebarContainer = $('.management-sidebar');
		this.contentContainer = $('.management-content');

		this.createSidebar();
		this.createContent();

		this.splitView = this.editorDisposables.add(new SplitView(this.splitViewContainer, {
			orientation: Orientation.HORIZONTAL,
			proportionalLayout: true,
		}));

		const savedWidth = this.storageService.getNumber(AI_CUSTOMIZATION_MANAGEMENT_SIDEBAR_WIDTH_KEY, StorageScope.PROFILE, SIDEBAR_DEFAULT_WIDTH);

		// Sidebar view
		this.splitView.addView({
			onDidChange: Event.None,
			element: this.sidebarContainer,
			minimumSize: SIDEBAR_MIN_WIDTH,
			maximumSize: SIDEBAR_MAX_WIDTH,
			layout: (width, _, height) => {
				this.sidebarContainer.style.width = `${width}px`;
				if (height !== undefined) {
					const listHeight = height - 24;
					this.sectionsList.layout(listHeight, width);
				}
			},
		}, savedWidth, undefined, true);

		// Content view
		this.splitView.addView({
			onDidChange: Event.None,
			element: this.contentContainer,
			minimumSize: CONTENT_MIN_WIDTH,
			maximumSize: Number.POSITIVE_INFINITY,
			layout: (width, _, height) => {
				this.contentContainer.style.width = `${width}px`;
				if (height !== undefined) {
					this.listWidget.layout(height - 16, width - 24); // Account for padding
					this.mcpListWidget.layout(height - 16, width - 24); // Account for padding
					// Models widget has footer, subtract footer height
					const modelsFooterHeight = this.modelsFooterElement?.offsetHeight || 80;
					this.modelsWidget.layout(height - 16 - modelsFooterHeight, width);

					// Layout embedded editor when in editor mode
					if (this.viewMode === 'editor' && this.embeddedEditor) {
						const editorHeaderHeight = 50; // Back button + item info header
						const padding = 24; // Content inner padding
						const editorHeight = height - editorHeaderHeight - padding;
						const editorWidth = width - padding;
						this.embeddedEditor.layout({ width: Math.max(0, editorWidth), height: Math.max(0, editorHeight) });
					}
				}
			},
		}, Sizing.Distribute, undefined, true);

		// Persist sidebar width
		this.editorDisposables.add(this.splitView.onDidSashChange(() => {
			const width = this.splitView.getViewSize(0);
			this.storageService.store(AI_CUSTOMIZATION_MANAGEMENT_SIDEBAR_WIDTH_KEY, width, StorageScope.PROFILE, StorageTarget.USER);
		}));

		// Reset on double-click
		this.editorDisposables.add(this.splitView.onDidSashReset(() => {
			const totalWidth = this.splitView.getViewSize(0) + this.splitView.getViewSize(1);
			this.splitView.resizeView(0, SIDEBAR_DEFAULT_WIDTH);
			this.splitView.resizeView(1, totalWidth - SIDEBAR_DEFAULT_WIDTH);
		}));
	}

	private createSidebar(): void {
		const sidebarContent = DOM.append(this.sidebarContainer, $('.sidebar-content'));

		// Main sections list container (takes remaining space)
		const sectionsListContainer = DOM.append(sidebarContent, $('.sidebar-sections-list'));

		this.sectionsList = this.editorDisposables.add(this.instantiationService.createInstance(
			WorkbenchList<ISectionItem>,
			'AICustomizationManagementSections',
			sectionsListContainer,
			new SectionItemDelegate(),
			[new SectionItemRenderer()],
			{
				multipleSelectionSupport: false,
				setRowLineHeight: false,
				horizontalScrolling: false,
				accessibilityProvider: {
					getAriaLabel: (item: ISectionItem) => item.label,
					getWidgetAriaLabel: () => localize('sectionsAriaLabel', "AI Customization Sections"),
				},
				openOnSingleClick: true,
				identityProvider: {
					getId: (item: ISectionItem) => item.id,
				},
			}
		));

		this.sectionsList.splice(0, this.sectionsList.length, this.sections);

		// Select the saved section
		const selectedIndex = this.sections.findIndex(s => s.id === this.selectedSection);
		if (selectedIndex >= 0) {
			this.sectionsList.setSelection([selectedIndex]);
		}

		this.editorDisposables.add(this.sectionsList.onDidChangeSelection(e => {
			if (e.elements.length > 0) {
				this.selectSection(e.elements[0].id);
			}
		}));
	}

	private createContent(): void {
		const contentInner = DOM.append(this.contentContainer, $('.content-inner'));

		// Container for prompts-based content (Agents, Skills, Instructions, Prompts)
		this.promptsContentContainer = DOM.append(contentInner, $('.prompts-content-container'));
		this.listWidget = this.editorDisposables.add(this.instantiationService.createInstance(AICustomizationListWidget));
		this.promptsContentContainer.appendChild(this.listWidget.element);

		// Handle item selection - open in embedded editor
		this.editorDisposables.add(this.listWidget.onDidSelectItem(item => {
			this.openItem(item);
		}));

		// Handle create actions - AI-guided creation
		this.editorDisposables.add(this.listWidget.onDidRequestCreate(promptType => {
			this.createNewItemWithAI(promptType);
		}));

		// Handle manual create actions - open editor directly
		this.editorDisposables.add(this.listWidget.onDidRequestCreateManual(({ type, target }) => {
			this.createNewItemManual(type, target);
		}));

		// Container for Models content
		this.modelsContentContainer = DOM.append(contentInner, $('.models-content-container'));

		this.modelsWidget = this.editorDisposables.add(this.instantiationService.createInstance(ChatModelsWidget));
		this.modelsContentContainer.appendChild(this.modelsWidget.element);

		// Models description footer
		this.modelsFooterElement = DOM.append(this.modelsContentContainer, $('.section-footer'));
		const modelsDescription = DOM.append(this.modelsFooterElement, $('p.section-footer-description'));
		modelsDescription.textContent = localize('modelsDescription', "Browse and manage language models from different providers. Select models for use in chat, code completion, and other AI features.");
		const modelsLink = DOM.append(this.modelsFooterElement, $('a.section-footer-link')) as HTMLAnchorElement;
		modelsLink.textContent = localize('learnMoreModels', "Learn more about language models");
		modelsLink.href = 'https://code.visualstudio.com/docs/copilot/customization/language-models';
		this.editorDisposables.add(DOM.addDisposableListener(modelsLink, 'click', (e) => {
			e.preventDefault();
			this.openerService.open(URI.parse(modelsLink.href));
		}));

		// Container for MCP content
		this.mcpContentContainer = DOM.append(contentInner, $('.mcp-content-container'));
		this.mcpListWidget = this.editorDisposables.add(this.instantiationService.createInstance(McpListWidget));
		this.mcpContentContainer.appendChild(this.mcpListWidget.element);

		// Container for embedded editor view
		this.editorContentContainer = DOM.append(contentInner, $('.editor-content-container'));
		this.createEmbeddedEditor();

		// Set initial visibility based on selected section
		this.updateContentVisibility();

		// Load items for the initial section
		if (this.isPromptsSection(this.selectedSection)) {
			void this.listWidget.setSection(this.selectedSection);
		}
	}

	private isPromptsSection(section: AICustomizationManagementSection): boolean {
		return section === AICustomizationManagementSection.Agents ||
			section === AICustomizationManagementSection.Skills ||
			section === AICustomizationManagementSection.Instructions ||
			section === AICustomizationManagementSection.Prompts ||
			section === AICustomizationManagementSection.Hooks;
	}

	private selectSection(section: AICustomizationManagementSection): void {
		if (this.selectedSection === section) {
			return;
		}

		// If in editor view, go back to list first
		if (this.viewMode === 'editor') {
			this.goBackToList();
		}

		this.selectedSection = section;
		this.sectionContextKey.set(section);

		// Persist selection
		this.storageService.store(AI_CUSTOMIZATION_MANAGEMENT_SELECTED_SECTION_KEY, section, StorageScope.PROFILE, StorageTarget.USER);

		// Update editor tab title
		this.updateEditorTitle();

		// Update content visibility
		this.updateContentVisibility();

		// Load items for the new section (only for prompts-based sections)
		if (this.isPromptsSection(section)) {
			void this.listWidget.setSection(section);
		}
	}

	private updateEditorTitle(): void {
		const sectionItem = this.sections.find(s => s.id === this.selectedSection);
		if (sectionItem && this.input instanceof AICustomizationManagementEditorInput) {
			this.input.setSectionLabel(sectionItem.label);
		}
	}

	private updateContentVisibility(): void {
		const isEditorMode = this.viewMode === 'editor';
		const isPromptsSection = this.isPromptsSection(this.selectedSection);
		const isModelsSection = this.selectedSection === AICustomizationManagementSection.Models;
		const isMcpSection = this.selectedSection === AICustomizationManagementSection.McpServers;

		// Hide all list containers when in editor mode
		this.promptsContentContainer.style.display = !isEditorMode && isPromptsSection ? '' : 'none';
		this.modelsContentContainer.style.display = !isEditorMode && isModelsSection ? '' : 'none';
		this.mcpContentContainer.style.display = !isEditorMode && isMcpSection ? '' : 'none';
		this.editorContentContainer.style.display = isEditorMode ? '' : 'none';

		// Render and layout models widget when switching to it
		if (isModelsSection) {
			this.modelsWidget.render();
			if (this.dimension) {
				this.layout(this.dimension);
			}
		}
	}

	private openItem(item: IAICustomizationListItem): void {
		const isWorktreeFile = item.storage === PromptsStorage.local;
		const isReadOnly = item.storage === PromptsStorage.extension;
		this.showEmbeddedEditor(item.uri, item.name, isWorktreeFile, isReadOnly);
	}

	/**
	 * Creates the embedded editor container with back button and CodeEditorWidget.
	 */
	private createEmbeddedEditor(): void {
		// Header with back button and item info
		const editorHeader = DOM.append(this.editorContentContainer, $('.editor-header'));

		// Back button
		const backButton = DOM.append(editorHeader, $('button.editor-back-button'));
		backButton.setAttribute('aria-label', localize('backToList', "Back to list"));
		const backIcon = DOM.append(backButton, $(`.codicon.codicon-${Codicon.arrowLeft.id}`));
		backIcon.setAttribute('aria-hidden', 'true');

		this.editorDisposables.add(DOM.addDisposableListener(backButton, 'click', () => {
			this.goBackToList();
		}));

		// Item info
		const itemInfo = DOM.append(editorHeader, $('.editor-item-info'));
		this.editorItemNameElement = DOM.append(itemInfo, $('.editor-item-name'));
		this.editorItemPathElement = DOM.append(itemInfo, $('.editor-item-path'));

		// Commit to Worktree button
		const commitButtonContainer = DOM.append(editorHeader, $('.editor-commit-button-container'));
		this.commitButton = this.editorDisposables.add(new Button(commitButtonContainer, { ...defaultButtonStyles, supportIcons: true }));
		this.commitButton.label = `$(${Codicon.gitCommit.id}) Commit to Worktree`;
		this.commitButton.element.classList.add('editor-commit-button');
		this.editorDisposables.add(this.commitButton.onDidClick(() => this.commitCurrentFileToWorktree()));

		// Editor container
		this.embeddedEditorContainer = DOM.append(this.editorContentContainer, $('.embedded-editor-container'));

		// Overflow widgets container - appended to the workbench root container so
		// hovers, suggest widgets, etc. are not clipped by overflow:hidden parents.
		const overflowWidgetsDomNode = this.layoutService.getContainer(DOM.getWindow(this.embeddedEditorContainer)).appendChild($('.embedded-editor-overflow-widgets.monaco-editor'));
		this.editorDisposables.add(toDisposable(() => overflowWidgetsDomNode.remove()));

		// Create the CodeEditorWidget
		const editorOptions = {
			...getSimpleEditorOptions(this.configurationService),
			readOnly: false,
			minimap: { enabled: false },
			lineNumbers: 'on' as const,
			wordWrap: 'on' as const,
			scrollBeyondLastLine: false,
			automaticLayout: false,
			folding: true,
			renderLineHighlight: 'all' as const,
			scrollbar: {
				vertical: 'auto' as const,
				horizontal: 'auto' as const,
			},
			overflowWidgetsDomNode,
		};

		this.embeddedEditor = this.editorDisposables.add(this.instantiationService.createInstance(
			CodeEditorWidget,
			this.embeddedEditorContainer,
			editorOptions,
			{
				isSimpleWidget: false,
				// Use default contributions for full IntelliSense, completions, linting, etc.
			}
		));
	}

	/**
	 * Shows the embedded editor with the content of the given item.
	 */
	private async showEmbeddedEditor(uri: URI, displayName: string, isWorktreeFile = false, isReadOnly = false): Promise<void> {
		// Dispose previous model reference if any
		this.currentModelRef?.dispose();
		this.currentModelRef = undefined;
		this.currentEditingUri = uri;

		this.viewMode = 'editor';

		// Update header info
		this.editorItemNameElement.textContent = displayName;
		this.editorItemPathElement.textContent = basename(uri);

		// Show commit button only for worktree files, disabled when nothing to commit
		if (isWorktreeFile) {
			this.commitButton.element.parentElement!.style.display = '';
			this.updateCommitButtonState();
		} else {
			this.commitButton.element.parentElement!.style.display = 'none';
		}

		// Update visibility
		this.updateContentVisibility();

		try {
			// Get the text model for the file
			const ref = await this.textModelService.createModelReference(uri);
			this.currentModelRef = ref;
			this.embeddedEditor.setModel(ref.object.textEditorModel);
			this.embeddedEditor.updateOptions({ readOnly: isReadOnly });

			// Listen for content changes to update commit button state
			this.editorDisposables.add(ref.object.textEditorModel.onDidChangeContent(() => {
				this.updateCommitButtonState();
			}));

			// Layout the editor
			if (this.dimension) {
				this.layout(this.dimension);
			}

			// Focus the editor
			this.embeddedEditor.focus();
		} catch (error) {
			// If we can't load the model, go back to the list
			console.error('Failed to load model for embedded editor:', error);
			this.goBackToList();
		}
	}

	/**
	 * Goes back from the embedded editor view to the list view.
	 */
	private goBackToList(): void {
		// Dispose model reference
		this.currentModelRef?.dispose();
		this.currentModelRef = undefined;
		this.currentEditingUri = undefined;

		// Clear editor model
		this.embeddedEditor.setModel(null);

		this.viewMode = 'list';

		// Update visibility
		this.updateContentVisibility();

		// Re-layout
		if (this.dimension) {
			this.layout(this.dimension);
		}

		// Focus the list
		this.listWidget?.focusSearch();
	}

	/**
	 * Commits the currently edited file to the worktree via git.
	 * This makes the file show up in the Changes view for the background session.
	 */
	private async commitCurrentFileToWorktree(): Promise<void> {
		if (!this.currentEditingUri) {
			return;
		}

		const worktreeDir = getActiveWorkingDirectory(this.customizationCreator['activeAgentSessionService']);
		if (!worktreeDir) {
			return;
		}

		const fileName = basename(this.currentEditingUri);

		// Show loading state on the button
		this.commitButton.enabled = false;
		const originalLabel = this.commitButton.label;
		this.commitButton.label = `$(${Codicon.loading.id}~spin) Committing...`;

		// Brief animation before committing
		await new Promise(resolve => setTimeout(resolve, 2000));

		// Find the SCM repository - it should already be registered via ensureWorktreeRepository()
		const repository = this.findRepository(this.currentEditingUri);
		if (!repository) {
			console.warn('[CommitToWorktree] No SCM repository found. Call ensureWorktreeRepository() first.');
			this.commitButton.label = originalLabel;
			this.commitButton.enabled = true;
			return;
		}

		// Set commit message, then use git.commitAll which stages + commits in one step
		repository.input.setValue(`Add customization: ${fileName}`, false);
		await this.commandService.executeCommand('git.commitAll', worktreeDir);

		// Restore button and update state
		this.commitButton.label = originalLabel;
		this.updateCommitButtonState();
		void this.listWidget.refresh();
	}

	/**
	 * Updates the commit button's enabled state.
	 * Enabled when the embedded editor has content to commit.
	 */
	private updateCommitButtonState(): void {
		if (!this.currentEditingUri || !this.embeddedEditor.hasModel()) {
			this.commitButton.enabled = false;
			return;
		}

		// Enable if the model has any content (newly created or modified)
		const model = this.embeddedEditor.getModel();
		this.commitButton.enabled = model !== null && model.getValueLength() > 0;
	}

	/**
	 * Ensures the git extension has opened the worktree repository.
	 * Should be called early (e.g., when the editor opens) so the repo
	 * is ready by the time the user clicks "Commit to Worktree".
	 */
	private async ensureWorktreeRepository(): Promise<void> {
		const worktreeDir = getActiveWorkingDirectory(this.customizationCreator['activeAgentSessionService']);
		if (!worktreeDir) {
			return;
		}

		if (!this.findRepository(worktreeDir)) {
			await this.commandService.executeCommand('git.openRepository', worktreeDir.fsPath);
		}
	}

	/**
	 * Finds an SCM repository that contains the given URI.
	 */
	private findRepository(uri: URI) {
		let repository = this.scmService.getRepository(uri);
		if (!repository) {
			for (const repo of [...this.scmService.repositories]) {
				const rootUri = repo.provider.rootUri;
				if (rootUri && uri.fsPath.startsWith(rootUri.fsPath)) {
					repository = repo;
					break;
				}
			}
		}
		return repository;
	}

	/**
	 * Creates a new customization using the AI-guided flow.
	 * Closes the management editor and opens a chat session with a hidden
	 * custom agent that guides the user through creating the customization.
	 */
	private async createNewItemWithAI(type: PromptsType): Promise<void> {
		// Close the management editor first so the chat is focused
		if (this.input) {
			await this.group.closeEditor(this.input);
		}

		await this.customizationCreator.createWithAI(type);
	}

	/**
	 * Creates a new prompt file. If there's an active worktree, asks the user
	 * whether to save in the worktree or user directory first.
	 */
	private async createNewItemManual(type: PromptsType, target: 'worktree' | 'user'): Promise<void> {
		// TODO: When creating a workspace customization file via 'New Workspace X',
		// the file is written directly to the worktree but there is currently no way
		// to commit it so it shows up in the Changes diff view for the worktree.
		// We need integration with the git worktree to stage/commit these new files.

		let targetDir = target === 'worktree'
			? this.customizationCreator.resolveTargetDirectory(type)
			: await this.customizationCreator.resolveUserDirectory(type);

		// Fallback to the source folder picker if we couldn't resolve the directory
		if (!targetDir) {
			const selectedFolder = await this.instantiationService.invokeFunction(askForPromptSourceFolder, type);
			if (!selectedFolder) {
				return;
			}
			targetDir = selectedFolder.uri;
		}

		let fileUri: URI;
		let cleanName: string;

		if (type === PromptsType.skill) {
			// Skills have a special flow: subfolder + SKILL.md
			const skillName = await this.quickInputService.input({
				prompt: localize('newSkillNamePrompt', "Enter a name for the skill (lowercase letters, numbers, and hyphens only)"),
				placeHolder: localize('newSkillNamePlaceholder', "e.g., pdf-processing, data-analysis"),
				validateInput: async (value) => {
					if (!value || !value.trim()) {
						return localize('skillNameRequired', "Skill name is required");
					}
					const name = value.trim();
					if (name.length > 64) {
						return localize('skillNameTooLong', "Skill name must be 64 characters or less");
					}
					if (!/^[a-z0-9-]+$/.test(name)) {
						return localize('skillNameInvalidChars', "Skill name may only contain lowercase letters, numbers, and hyphens");
					}
					if (name.startsWith('-') || name.endsWith('-')) {
						return localize('skillNameHyphenEdge', "Skill name must not start or end with a hyphen");
					}
					if (name.includes('--')) {
						return localize('skillNameConsecutiveHyphens', "Skill name must not contain consecutive hyphens");
					}
					return undefined;
				}
			});
			if (!skillName) {
				return;
			}
			const trimmedName = skillName.trim();
			const skillFolder = URI.joinPath(targetDir, trimmedName);
			await this.fileService.createFolder(skillFolder);
			fileUri = URI.joinPath(skillFolder, SKILL_FILENAME);
			cleanName = trimmedName;
		} else {
			// Standard flow: ask for file name via quick input
			const fileExtension = getPromptFileExtension(type);
			const fileName = await this.quickInputService.input({
				prompt: localize('newFileName', "Enter a name"),
				placeHolder: localize('newFileNamePlaceholder', "e.g., my-{0}", fileExtension),
				validateInput: async (value) => {
					if (!value || !value.trim()) {
						return localize('fileNameRequired', "Name is required");
					}
					return undefined;
				}
			});
			if (!fileName) {
				return;
			}
			const trimmedName = fileName.trim();
			const fullFileName = trimmedName.endsWith(fileExtension) ? trimmedName : trimmedName + fileExtension;
			await this.fileService.createFolder(targetDir);
			fileUri = URI.joinPath(targetDir, fullFileName);
			cleanName = getCleanPromptName(fileUri);
		}

		// Create the file and open in embedded editor
		try {
			await this.fileService.createFile(fileUri);
		} catch (error) {
			console.error('Failed to create file:', error);
			return;
		}

		// Open in embedded editor
		await this.showEmbeddedEditor(fileUri, cleanName, target === 'worktree');

		// Apply the default snippet template
		if (this.embeddedEditor.hasModel()) {
			SnippetController2.get(this.embeddedEditor)?.apply([{
				range: this.embeddedEditor.getModel()!.getFullModelRange(),
				template: getDefaultContentSnippet(type, cleanName),
			}]);
		}

		// Refresh the list so the new item appears
		void this.listWidget.refresh();
	}

	override updateStyles(): void {
		const borderColor = this.theme.getColor(aiCustomizationManagementSashBorder);
		if (borderColor) {
			this.splitView?.style({ separatorBorder: borderColor });
		}
	}

	override async setInput(input: AICustomizationManagementEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this.inEditorContextKey.set(true);
		this.sectionContextKey.set(this.selectedSection);

		await super.setInput(input, options, context, token);

		// Set initial editor tab title
		this.updateEditorTitle();

		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override clearInput(): void {
		this.inEditorContextKey.set(false);
		this.inputDisposables.clear();

		// Clean up embedded editor state
		if (this.viewMode === 'editor') {
			this.goBackToList();
		}

		super.clearInput();
	}

	override layout(dimension: DOM.Dimension): void {
		this.dimension = dimension;

		if (this.container && this.splitView) {
			this.splitViewContainer.style.height = `${dimension.height}px`;
			this.splitView.layout(dimension.width, dimension.height);
		}
	}

	override focus(): void {
		super.focus();
		// When in editor mode, focus the editor
		if (this.viewMode === 'editor') {
			this.embeddedEditor?.focus();
			return;
		}
		if (this.selectedSection === AICustomizationManagementSection.McpServers) {
			this.mcpListWidget?.focusSearch();
		} else if (this.selectedSection === AICustomizationManagementSection.Models) {
			this.modelsWidget?.focusSearch();
		} else {
			this.listWidget?.focusSearch();
		}
	}

	/**
	 * Selects a specific section programmatically.
	 */
	public selectSectionById(sectionId: AICustomizationManagementSection): void {
		const index = this.sections.findIndex(s => s.id === sectionId);
		if (index >= 0) {
			this.sectionsList.setFocus([index]);
			this.sectionsList.setSelection([index]);
		}
	}
}
