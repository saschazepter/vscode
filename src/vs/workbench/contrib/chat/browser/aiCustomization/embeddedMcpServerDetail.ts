/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { LocalMcpServerScope } from '../../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { IMcpWorkbenchService, IWorkbenchMcpServer } from '../../../mcp/common/mcpTypes.js';
import { mcpServerIcon, userIcon, workspaceIcon } from './aiCustomizationIcons.js';

const $ = DOM.$;

/**
 * Compact detail view for an MCP server inside the AI Customizations management editor's
 * split-pane host. Renders identity (icon + name + scope) and description, plus an
 * "Open in editor" link that opens the full {@link McpServerEditor} in the main editor area.
 *
 * Advanced actions (enable / disable / uninstall / configure) remain accessible via the
 * row's existing context menu, so this component intentionally stays small.
 */
export class EmbeddedMcpServerDetail extends Disposable {

	private readonly root: HTMLElement;
	private readonly iconEl: HTMLElement;
	private readonly nameEl: HTMLElement;
	private readonly scopeEl: HTMLElement;
	private readonly descriptionEl: HTMLElement;
	private readonly openLink: HTMLAnchorElement;
	private readonly emptyEl: HTMLElement;

	private current: IWorkbenchMcpServer | undefined;

	constructor(
		parent: HTMLElement,
		@IMcpWorkbenchService private readonly mcpWorkbenchService: IMcpWorkbenchService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();

		this.root = DOM.append(parent, $('.ai-customization-embedded-detail.embedded-mcp-detail'));

		const header = DOM.append(this.root, $('.embedded-detail-header'));
		this.iconEl = DOM.append(header, $('.embedded-detail-icon'));
		const headerText = DOM.append(header, $('.embedded-detail-header-text'));
		this.nameEl = DOM.append(headerText, $('h2.embedded-detail-name'));
		this.nameEl.setAttribute('role', 'heading');
		this.scopeEl = DOM.append(headerText, $('.embedded-detail-scope'));

		this.descriptionEl = DOM.append(this.root, $('.embedded-detail-description'));

		const actions = DOM.append(this.root, $('.embedded-detail-actions'));
		this.openLink = DOM.append(actions, $<HTMLAnchorElement>('a.embedded-detail-open-link'));
		this.openLink.textContent = localize('mcpOpenInEditor', "Open in editor");
		this.openLink.setAttribute('role', 'button');
		this.openLink.setAttribute('tabindex', '0');
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.openLink, localize('mcpOpenInEditorTooltip', "Open this MCP server in the full editor")));
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
		this.emptyEl.textContent = localize('mcpDetailEmpty', "No MCP server selected.");

		// Refresh when the underlying server changes (install state, enablement, etc.).
		this._register(this.mcpWorkbenchService.onChange(server => {
			if (this.current && server && server.id === this.current.id) {
				this.current = server;
				this.renderItem();
			}
		}));

		this.renderItem();
	}

	get element(): HTMLElement {
		return this.root;
	}

	setInput(server: IWorkbenchMcpServer): void {
		this.current = server;
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
		this.mcpWorkbenchService.open(this.current);
	}

	private renderItem(): void {
		const server = this.current;
		const hasItem = !!server;
		this.emptyEl.style.display = hasItem ? 'none' : '';
		this.root.classList.toggle('is-empty', !hasItem);
		if (!server) {
			this.nameEl.textContent = '';
			this.scopeEl.textContent = '';
			this.descriptionEl.textContent = '';
			this.iconEl.className = 'embedded-detail-icon';
			return;
		}

		this.nameEl.textContent = server.label || server.name;

		// Icon: prefer codicon hint, fall back to the standard MCP server icon.
		const iconClasses = ['embedded-detail-icon', 'codicon'];
		const codiconId = server.codicon && (Codicon as Record<string, unknown>)[server.codicon] ? server.codicon : mcpServerIcon.id;
		iconClasses.push(`codicon-${codiconId}`);
		this.iconEl.className = iconClasses.join(' ');

		// Scope label
		const scope = server.local?.scope;
		const scopeInfo = describeMcpScope(scope);
		if (scopeInfo) {
			const scopeIcon = DOM.$(`span.codicon.codicon-${scopeInfo.icon.id}`);
			this.scopeEl.replaceChildren(scopeIcon, document.createTextNode(' ' + scopeInfo.label));
			this.scopeEl.style.display = '';
		} else {
			this.scopeEl.replaceChildren();
			this.scopeEl.style.display = 'none';
		}

		// Description (single line, but allow wrapping in CSS)
		const description = (server.description || '').trim();
		this.descriptionEl.textContent = description;
		this.descriptionEl.style.display = description ? '' : 'none';
	}
}

function describeMcpScope(scope: LocalMcpServerScope | undefined): { label: string; icon: ThemeIcon } | undefined {
	switch (scope) {
		case LocalMcpServerScope.Workspace:
			return { label: localize('mcpScopeWorkspace', "Workspace"), icon: workspaceIcon };
		case LocalMcpServerScope.User:
		case LocalMcpServerScope.RemoteUser:
			return { label: localize('mcpScopeUser', "User"), icon: userIcon };
		default:
			return undefined;
	}
}
