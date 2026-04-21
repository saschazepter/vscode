/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationManagement.css';
import * as DOM from '../../../../base/browser/dom.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { AICustomizationManagementSection, AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagement.js';
import { AICustomizationManagementEditorInput } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementEditorInput.js';
import { agentIcon, instructionsIcon, mcpServerIcon, pluginIcon, skillIcon } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationIcons.js';
import { ICustomizationCountsService } from '../../../../workbench/contrib/chat/browser/aiCustomization/customizationCountsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';

const $ = DOM.$;

export const AI_CUSTOMIZATION_OVERVIEW_VIEW_ID = 'workbench.view.aiCustomizationOverview';

function isWelcomePageEditor(editor: unknown): editor is { showWelcomePage(): void } {
	return typeof (editor as { showWelcomePage?: unknown })?.showWelcomePage === 'function';
}

interface ISectionSummary {
	readonly id: AICustomizationManagementSection;
	readonly label: string;
	readonly icon: ThemeIcon;
}

/**
 * A compact overview view that shows a snapshot of AI customizations
 * and provides deep-links to the management editor sections.
 */
export class AICustomizationOverviewView extends ViewPane {

	private bodyElement!: HTMLElement;
	private container!: HTMLElement;
	private sectionsContainer!: HTMLElement;
	private readonly sections: readonly ISectionSummary[] = [
		{ id: AICustomizationManagementSection.Agents, label: localize('agents', "Agents"), icon: agentIcon },
		{ id: AICustomizationManagementSection.Skills, label: localize('skills', "Skills"), icon: skillIcon },
		{ id: AICustomizationManagementSection.Instructions, label: localize('instructions', "Instructions"), icon: instructionsIcon },
		{ id: AICustomizationManagementSection.McpServers, label: localize('mcpServers', "MCP Servers"), icon: mcpServerIcon },
		{ id: AICustomizationManagementSection.Plugins, label: localize('plugins', "Plugins"), icon: pluginIcon },
	];

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IEditorService private readonly editorService: IEditorService,
		@ICustomizationCountsService private readonly countsService: ICustomizationCountsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.bodyElement = container;
		this.container = DOM.append(container, $('.ai-customization-overview'));
		this.sectionsContainer = DOM.append(this.container, $('.overview-sections'));

		this.renderSections();

		// Force initial layout
		this.layoutBody(this.bodyElement.offsetHeight, this.bodyElement.offsetWidth);
	}

	private renderSections(): void {
		DOM.clearNode(this.sectionsContainer);

		for (const section of this.sections) {
			const sectionElement = DOM.append(this.sectionsContainer, $('.overview-section'));
			sectionElement.tabIndex = 0;
			sectionElement.setAttribute('role', 'button');

			const iconElement = DOM.append(sectionElement, $('.section-icon'));
			iconElement.classList.add(...ThemeIcon.asClassNameArray(section.icon));

			const textContainer = DOM.append(sectionElement, $('.section-text'));
			const labelElement = DOM.append(textContainer, $('.section-label'));
			labelElement.textContent = section.label;

			const countElement = DOM.append(sectionElement, $('.section-count'));

			// Drive count + aria-label off the shared counts service.
			const count$ = this.countsService.observeCount(section.id);
			this._register(autorun(reader => {
				const count = count$.read(reader);
				countElement.textContent = `${count}`;
				sectionElement.setAttribute('aria-label', `${section.label}: ${count} items`);
			}));

			// Click handler to open the management editor overview
			this._register(DOM.addDisposableListener(sectionElement, 'click', () => {
				this.openOverview();
			}));

			// Keyboard support
			this._register(DOM.addDisposableListener(sectionElement, 'keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.openOverview();
				}
			}));

			// Hover tooltip
			this._register(this.hoverService.setupDelayedHoverAtMouse(sectionElement, () => ({
				content: localize('openOverview', "Open Chat Customizations editor"),
				appearance: { compact: true, skipFadeInAnimation: true }
			})));
		}
	}

	private async openOverview(): Promise<void> {
		const input = AICustomizationManagementEditorInput.getOrCreate();
		const editor = await this.editorService.openEditor(input, { pinned: true });

		// Always reset to the welcome page when opening from the sidebar,
		// so we don't restore the previously selected section.
		if (editor?.getId() === AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID && isWelcomePageEditor(editor)) {
			editor.showWelcomePage();
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.container.style.height = `${height}px`;
	}
}
