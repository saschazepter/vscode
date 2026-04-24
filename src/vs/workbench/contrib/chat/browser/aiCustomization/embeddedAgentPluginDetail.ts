/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { AgentPluginEditorInput } from '../agentPluginEditor/agentPluginEditorInput.js';
import { AgentPluginItemKind, IAgentPluginItem } from '../agentPluginEditor/agentPluginItems.js';
import { extensionIcon, pluginIcon } from './aiCustomizationIcons.js';

const $ = DOM.$;

/**
 * Compact detail view for an agent plugin inside the AI Customizations management editor's
 * split-pane host. Renders identity (icon + name + source) and description, plus an
 * "Open in editor" link that opens the full {@link AgentPluginEditor} in the main editor area.
 *
 * Advanced actions (enable / disable / uninstall) remain accessible via the row's existing
 * context menu, so this component intentionally stays small.
 */
export class EmbeddedAgentPluginDetail extends Disposable {

	private readonly root: HTMLElement;
	private readonly iconEl: HTMLElement;
	private readonly nameEl: HTMLElement;
	private readonly sourceEl: HTMLElement;
	private readonly descriptionEl: HTMLElement;
	private readonly openLink: HTMLAnchorElement;
	private readonly emptyEl: HTMLElement;

	private current: IAgentPluginItem | undefined;

	constructor(
		parent: HTMLElement,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();

		this.root = DOM.append(parent, $('.ai-customization-embedded-detail.embedded-plugin-detail'));

		const header = DOM.append(this.root, $('.embedded-detail-header'));
		this.iconEl = DOM.append(header, $('.embedded-detail-icon'));
		const headerText = DOM.append(header, $('.embedded-detail-header-text'));
		this.nameEl = DOM.append(headerText, $('h2.embedded-detail-name'));
		this.nameEl.setAttribute('role', 'heading');
		this.sourceEl = DOM.append(headerText, $('.embedded-detail-scope'));

		this.descriptionEl = DOM.append(this.root, $('.embedded-detail-description'));

		const actions = DOM.append(this.root, $('.embedded-detail-actions'));
		this.openLink = DOM.append(actions, $<HTMLAnchorElement>('a.embedded-detail-open-link'));
		this.openLink.textContent = localize('pluginOpenInEditor', "Open in editor");
		this.openLink.setAttribute('role', 'button');
		this.openLink.setAttribute('tabindex', '0');
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.openLink, localize('pluginOpenInEditorTooltip', "Open this plugin in the full editor")));
		this._register(DOM.addDisposableListener(this.openLink, 'click', e => {
			e.preventDefault();
			this.openInFullEditor();
		}));
		this._register(DOM.addDisposableListener(this.openLink, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.openInFullEditor();
			}
		}));

		this.emptyEl = DOM.append(this.root, $('.embedded-detail-empty'));
		this.emptyEl.textContent = localize('pluginDetailEmpty', "No plugin selected.");

		this.renderItem();
	}

	get element(): HTMLElement {
		return this.root;
	}

	setInput(item: IAgentPluginItem): void {
		this.current = item;
		this.renderItem();
	}

	clearInput(): void {
		this.current = undefined;
		this.renderItem();
	}

	private openInFullEditor(): void {
		if (!this.current) {
			return;
		}
		const input = this.instantiationService.createInstance(AgentPluginEditorInput, this.current);
		this.editorService.openEditor(input);
	}

	private renderItem(): void {
		const item = this.current;
		const hasItem = !!item;
		this.emptyEl.style.display = hasItem ? 'none' : '';
		this.root.classList.toggle('is-empty', !hasItem);
		if (!item) {
			this.nameEl.textContent = '';
			this.sourceEl.textContent = '';
			this.descriptionEl.textContent = '';
			this.iconEl.className = 'embedded-detail-icon';
			return;
		}

		this.nameEl.textContent = item.name;

		const isMarketplace = item.kind === AgentPluginItemKind.Marketplace;
		const iconId = isMarketplace ? extensionIcon.id : pluginIcon.id;
		this.iconEl.className = `embedded-detail-icon codicon codicon-${iconId}`;

		const sourceLabel = item.marketplace
			? (isMarketplace
				? localize('pluginSourceMarketplace', "From {0}", item.marketplace)
				: localize('pluginSourceInstalled', "Installed from {0}", item.marketplace))
			: (isMarketplace
				? localize('pluginSourceMarketplaceUnknown', "Marketplace plugin")
				: localize('pluginSourceLocal', "Installed plugin"));
		const iconSpan = $(`span.codicon.codicon-${iconId}`);
		this.sourceEl.replaceChildren(iconSpan, document.createTextNode(' ' + sourceLabel));

		const description = (item.description || '').trim();
		this.descriptionEl.textContent = description;
		this.descriptionEl.style.display = description ? '' : 'none';
	}
}
