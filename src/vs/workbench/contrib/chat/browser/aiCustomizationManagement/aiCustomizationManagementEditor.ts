/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationManagement.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { Orientation, Sizing, SplitView } from '../../../../../base/browser/ui/splitview/splitview.js';
import { localize } from '../../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextKey, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IListVirtualDelegate, IListRenderer } from '../../../../../base/browser/ui/list/list.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { URI } from '../../../../../base/common/uri.js';
import { registerColor } from '../../../../../platform/theme/common/colorRegistry.js';
import { PANEL_BORDER } from '../../../../common/theme.js';
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
import { agentIcon, instructionsIcon, promptIcon, skillIcon } from '../aiCustomizationTreeView/aiCustomizationTreeViewIcons.js';
import { AI_CUSTOMIZATION_EDITOR_ID } from '../aiCustomizationEditor/aiCustomizationEditor.js';
import { ChatModelsWidget } from '../chatManagement/chatModelsWidget.js';

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
	private headerContainer!: HTMLElement;
	private titleElement!: HTMLElement;
	private newButton!: Button;
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
	private modelsHeaderElement!: HTMLElement;

	private dimension: Dimension | undefined;
	private readonly sections: ISectionItem[] = [];
	private selectedSection: AICustomizationManagementSection = AICustomizationManagementSection.Agents;

	private readonly editorDisposables = this._register(new DisposableStore());
	private readonly inputDisposables = this._register(new MutableDisposable());

	private readonly inEditorContextKey: IContextKey<boolean>;
	private readonly sectionContextKey: IContextKey<string>;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super(AICustomizationManagementEditor.ID, group, telemetryService, themeService, storageService);

		this.inEditorContextKey = CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_EDITOR.bindTo(contextKeyService);
		this.sectionContextKey = CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_SECTION.bindTo(contextKeyService);

		// Initialize sections
		this.sections.push(
			{ id: AICustomizationManagementSection.Agents, label: localize('agents', "Agents"), icon: agentIcon },
			{ id: AICustomizationManagementSection.Skills, label: localize('skills', "Skills"), icon: skillIcon },
			{ id: AICustomizationManagementSection.Instructions, label: localize('instructions', "Instructions"), icon: instructionsIcon },
			{ id: AICustomizationManagementSection.Prompts, label: localize('prompts', "Prompts"), icon: promptIcon },
			{ id: AICustomizationManagementSection.McpServers, label: localize('mcpServers', "MCP Servers"), icon: Codicon.server },
			{ id: AICustomizationManagementSection.Models, label: localize('models', "Models"), icon: Codicon.sparkle },
		);

		// Restore selected section from storage
		const savedSection = this.storageService.get(AI_CUSTOMIZATION_MANAGEMENT_SELECTED_SECTION_KEY, StorageScope.PROFILE);
		if (savedSection && Object.values(AICustomizationManagementSection).includes(savedSection as AICustomizationManagementSection)) {
			this.selectedSection = savedSection as AICustomizationManagementSection;
		}
	}

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		this.container = DOM.append(parent, $('.ai-customization-management-editor'));

		this.createHeader();
		this.createSplitView();
		this.updateStyles();
	}

	private createHeader(): void {
		this.headerContainer = DOM.append(this.container, $('.management-header'));

		// Title - dynamically shows selected section
		const titleContainer = DOM.append(this.headerContainer, $('.header-title-container'));
		this.titleElement = DOM.append(titleContainer, $('.header-title'));

		// New button - context-aware based on selected section
		const buttonContainer = DOM.append(this.headerContainer, $('.header-actions'));
		this.newButton = this.editorDisposables.add(new Button(buttonContainer, {
			...defaultButtonStyles,
			supportIcons: true,
		}));
		this.newButton.element.classList.add('new-button');

		this.editorDisposables.add(this.newButton.onDidClick(() => {
			this.executeNewItemAction();
		}));

		// Initialize header with current section
		this.updateHeader();
	}

	private updateHeader(): void {
		const sectionInfo = this.getSectionInfo(this.selectedSection);
		this.titleElement.textContent = sectionInfo.title;

		if (sectionInfo.newButtonLabel) {
			this.newButton.label = `$(${Codicon.add.id}) ${sectionInfo.newButtonLabel}`;
			this.newButton.element.style.display = '';
		} else {
			this.newButton.element.style.display = 'none';
		}
	}

	private getSectionInfo(section: AICustomizationManagementSection): { title: string; newButtonLabel?: string; newCommand?: string } {
		switch (section) {
			case AICustomizationManagementSection.Agents:
				return {
					title: localize('agentsTitle', "Agents"),
					// Button is now in the search bar area within the widget
				};
			case AICustomizationManagementSection.Skills:
				return {
					title: localize('skillsTitle', "Skills"),
					// Button is now in the search bar area within the widget
				};
			case AICustomizationManagementSection.Instructions:
				return {
					title: localize('instructionsTitle', "Instructions"),
					// Button is now in the search bar area within the widget
				};
			case AICustomizationManagementSection.Prompts:
				return {
					title: localize('promptsTitle', "Prompts"),
					// Button is now in the search bar area within the widget
				};
			case AICustomizationManagementSection.Models:
				return {
					title: localize('modelsTitle', "Models"),
					// Models has its own "Add Models..." button in the widget
				};
			case AICustomizationManagementSection.McpServers:
				return {
					title: localize('mcpServersTitle', "MCP Servers"),
					// MCP Servers has its own "Add Server" button in the widget
				};
		}
	}

	private executeNewItemAction(): void {
		const sectionInfo = this.getSectionInfo(this.selectedSection);
		if (sectionInfo.newCommand) {
			this.commandService.executeCommand(sectionInfo.newCommand);
		}
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
					this.sectionsList.layout(height, width);
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
					// Models widget has header, subtract header height
					const modelsHeaderHeight = this.modelsHeaderElement?.offsetHeight || 80;
					this.modelsWidget.layout(height - 16 - modelsHeaderHeight, width);
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

		this.sectionsList = this.editorDisposables.add(this.instantiationService.createInstance(
			WorkbenchList<ISectionItem>,
			'AICustomizationManagementSections',
			sidebarContent,
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

		// Handle item selection - open in form editor
		this.editorDisposables.add(this.listWidget.onDidSelectItem(item => {
			this.openItem(item);
		}));

		// Container for Models content
		this.modelsContentContainer = DOM.append(contentInner, $('.models-content-container'));

		// Models description header
		this.modelsHeaderElement = DOM.append(this.modelsContentContainer, $('.section-header'));
		const modelsDescription = DOM.append(this.modelsHeaderElement, $('p.section-header-description'));
		modelsDescription.textContent = localize('modelsDescription', "Browse and manage language models from different providers. Select models for use in chat, code completion, and other AI features.");
		const modelsLink = DOM.append(this.modelsHeaderElement, $('a.section-header-link')) as HTMLAnchorElement;
		modelsLink.textContent = localize('learnMoreModels', "Learn more about language models");
		modelsLink.href = 'https://code.visualstudio.com/docs/copilot/customization/language-models';
		this.editorDisposables.add(DOM.addDisposableListener(modelsLink, 'click', (e) => {
			e.preventDefault();
			this.openerService.open(URI.parse(modelsLink.href));
		}));

		this.modelsWidget = this.editorDisposables.add(this.instantiationService.createInstance(ChatModelsWidget));
		this.modelsContentContainer.appendChild(this.modelsWidget.element);

		// Container for MCP content
		this.mcpContentContainer = DOM.append(contentInner, $('.mcp-content-container'));
		this.mcpListWidget = this.editorDisposables.add(this.instantiationService.createInstance(McpListWidget));
		this.mcpContentContainer.appendChild(this.mcpListWidget.element);

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
			section === AICustomizationManagementSection.Prompts;
	}

	private selectSection(section: AICustomizationManagementSection): void {
		if (this.selectedSection === section) {
			return;
		}

		this.selectedSection = section;
		this.sectionContextKey.set(section);

		// Persist selection
		this.storageService.store(AI_CUSTOMIZATION_MANAGEMENT_SELECTED_SECTION_KEY, section, StorageScope.PROFILE, StorageTarget.USER);

		// Update header to reflect new section
		this.updateHeader();

		// Update content visibility
		this.updateContentVisibility();

		// Load items for the new section (only for prompts-based sections)
		if (this.isPromptsSection(section)) {
			void this.listWidget.setSection(section);
		}
	}

	private updateContentVisibility(): void {
		const isPromptsSection = this.isPromptsSection(this.selectedSection);
		const isModelsSection = this.selectedSection === AICustomizationManagementSection.Models;
		const isMcpSection = this.selectedSection === AICustomizationManagementSection.McpServers;

		this.promptsContentContainer.style.display = isPromptsSection ? '' : 'none';
		this.modelsContentContainer.style.display = isModelsSection ? '' : 'none';
		this.mcpContentContainer.style.display = isMcpSection ? '' : 'none';

		// Render and layout models widget when switching to it
		if (isModelsSection) {
			this.modelsWidget.render();
			if (this.dimension) {
				this.layout(this.dimension);
			}
		}
	}

	private openItem(item: IAICustomizationListItem): void {
		this.editorService.openEditor({
			resource: item.uri,
			options: { override: AI_CUSTOMIZATION_EDITOR_ID }
		});
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

		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override clearInput(): void {
		this.inEditorContextKey.set(false);
		this.inputDisposables.clear();
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;

		if (this.container && this.splitView) {
			const headerHeight = this.headerContainer?.offsetHeight || 48;
			const splitViewHeight = dimension.height - headerHeight;

			this.splitViewContainer.style.height = `${splitViewHeight}px`;
			this.splitView.layout(dimension.width, splitViewHeight);
		}
	}

	override focus(): void {
		super.focus();
		if (this.selectedSection === AICustomizationManagementSection.McpServers) {
			this.mcpListWidget?.focus();
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
