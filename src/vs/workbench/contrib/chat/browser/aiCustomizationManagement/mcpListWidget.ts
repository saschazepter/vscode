/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationManagement.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IListVirtualDelegate, IListRenderer } from '../../../../../base/browser/ui/list/list.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IMcpWorkbenchService, IWorkbenchMcpServer, McpConnectionState, IMcpService } from '../../../mcp/common/mcpTypes.js';
import { McpCommandIds } from '../../../mcp/common/mcpCommandIds.js';
import { autorun } from '../../../../../base/common/observable.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { URI } from '../../../../../base/common/uri.js';

const $ = DOM.$;

const MCP_ITEM_HEIGHT = 60;

/**
 * Delegate for the MCP server list.
 */
class McpServerItemDelegate implements IListVirtualDelegate<IWorkbenchMcpServer> {
	getHeight(): number {
		return MCP_ITEM_HEIGHT;
	}

	getTemplateId(): string {
		return 'mcpServerItem';
	}
}

interface IMcpServerItemTemplateData {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly description: HTMLElement;
	readonly status: HTMLElement;
	readonly disposables: DisposableStore;
}

/**
 * Renderer for MCP server list items.
 */
class McpServerItemRenderer implements IListRenderer<IWorkbenchMcpServer, IMcpServerItemTemplateData> {
	readonly templateId = 'mcpServerItem';

	constructor(
		@IMcpService private readonly mcpService: IMcpService,
	) { }

	renderTemplate(container: HTMLElement): IMcpServerItemTemplateData {
		container.classList.add('mcp-server-item');

		const icon = DOM.append(container, $('.mcp-server-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.server));

		const details = DOM.append(container, $('.mcp-server-details'));
		const name = DOM.append(details, $('.mcp-server-name'));
		const description = DOM.append(details, $('.mcp-server-description'));

		const status = DOM.append(container, $('.mcp-server-status'));

		return { container, icon, name, description, status, disposables: new DisposableStore() };
	}

	renderElement(element: IWorkbenchMcpServer, index: number, templateData: IMcpServerItemTemplateData): void {
		templateData.disposables.clear();

		templateData.name.textContent = element.label;
		templateData.description.textContent = element.description || '';

		// Find the server from IMcpService to get connection state
		const server = this.mcpService.servers.get().find(s => s.definition.id === element.id);
		templateData.disposables.add(autorun(reader => {
			const connectionState = server?.connectionState.read(reader);
			this.updateStatus(templateData.status, connectionState?.state);
		}));
	}

	private updateStatus(statusElement: HTMLElement, state: McpConnectionState.Kind | undefined): void {
		statusElement.className = 'mcp-server-status';

		switch (state) {
			case McpConnectionState.Kind.Running:
				statusElement.textContent = localize('running', "Running");
				statusElement.classList.add('running');
				break;
			case McpConnectionState.Kind.Starting:
				statusElement.textContent = localize('starting', "Starting");
				statusElement.classList.add('starting');
				break;
			case McpConnectionState.Kind.Error:
				statusElement.textContent = localize('error', "Error");
				statusElement.classList.add('error');
				break;
			case McpConnectionState.Kind.Stopped:
			default:
				statusElement.textContent = localize('stopped', "Stopped");
				statusElement.classList.add('stopped');
				break;
		}
	}

	disposeTemplate(templateData: IMcpServerItemTemplateData): void {
		templateData.disposables.dispose();
	}
}

/**
 * Widget that displays a list of MCP servers.
 */
export class McpListWidget extends Disposable {

	readonly element: HTMLElement;

	private sectionHeader!: HTMLElement;
	private sectionTitle!: HTMLElement;
	private sectionDescription!: HTMLElement;
	private sectionLink!: HTMLAnchorElement;
	private listContainer!: HTMLElement;
	private list!: WorkbenchList<IWorkbenchMcpServer>;
	private emptyContainer!: HTMLElement;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IMcpWorkbenchService private readonly mcpWorkbenchService: IMcpWorkbenchService,
		@IMcpService private readonly mcpService: IMcpService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.element = $('.mcp-list-widget');
		this.create();
	}

	private create(): void {
		// Section header at top with description and link
		this.sectionHeader = DOM.append(this.element, $('.section-header'));
		this.sectionTitle = DOM.append(this.sectionHeader, $('h2.section-header-title'));
		this.sectionTitle.textContent = localize('mcpServersTitle', "MCP Servers");
		this.sectionDescription = DOM.append(this.sectionHeader, $('p.section-header-description'));
		this.sectionDescription.textContent = localize('mcpServersDescription', "Model Context Protocol servers that provide additional tools and capabilities. MCP servers can extend Copilot with custom tools, data sources, and integrations.");
		this.sectionLink = DOM.append(this.sectionHeader, $('a.section-header-link')) as HTMLAnchorElement;
		this.sectionLink.textContent = localize('learnMoreMcp', "Learn more about MCP servers");
		this.sectionLink.href = 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers';
		this._register(DOM.addDisposableListener(this.sectionLink, 'click', (e) => {
			e.preventDefault();
			const href = this.sectionLink.href;
			if (href) {
				this.openerService.open(URI.parse(href));
			}
		}));

		// Empty state
		this.emptyContainer = DOM.append(this.element, $('.mcp-empty-state'));
		const emptyIcon = DOM.append(this.emptyContainer, $('.empty-icon'));
		emptyIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.server));
		const emptyText = DOM.append(this.emptyContainer, $('.empty-text'));
		emptyText.textContent = localize('noMcpServers', "No MCP servers configured");
		const emptySubtext = DOM.append(this.emptyContainer, $('.empty-subtext'));
		emptySubtext.textContent = localize('addMcpServer', "Add an MCP server configuration to get started");

		const emptyButton = this._register(new Button(this.emptyContainer, { ...defaultButtonStyles }));
		emptyButton.label = localize('addConfiguration', "Add Configuration");
		this._register(emptyButton.onDidClick(() => {
			this.commandService.executeCommand(McpCommandIds.AddConfiguration);
		}));

		// List container
		this.listContainer = DOM.append(this.element, $('.mcp-list-container'));

		// Create list
		const delegate = new McpServerItemDelegate();
		const renderer = this.instantiationService.createInstance(McpServerItemRenderer);

		this.list = this._register(this.instantiationService.createInstance(
			WorkbenchList<IWorkbenchMcpServer>,
			'McpManagementList',
			this.listContainer,
			delegate,
			[renderer],
			{
				multipleSelectionSupport: false,
				setRowLineHeight: false,
				horizontalScrolling: false,
				accessibilityProvider: {
					getAriaLabel(element: IWorkbenchMcpServer) {
						return element.label;
					},
					getWidgetAriaLabel() {
						return localize('mcpServersListAriaLabel', "MCP Servers");
					}
				},
				openOnSingleClick: true,
				identityProvider: {
					getId(element: IWorkbenchMcpServer) {
						return element.id;
					}
				}
			}
		));

		this._register(this.list.onDidOpen(e => {
			if (e.element) {
				this.mcpWorkbenchService.open(e.element);
			}
		}));

		// Listen to MCP service changes
		this._register(this.mcpWorkbenchService.onChange(() => this.refresh()));
		this._register(autorun(reader => {
			this.mcpService.servers.read(reader);
			this.refresh();
		}));

		// Initial refresh
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		const servers = await this.mcpWorkbenchService.queryLocal();

		if (servers.length === 0) {
			this.emptyContainer.style.display = 'flex';
			this.listContainer.style.display = 'none';
		} else {
			this.emptyContainer.style.display = 'none';
			this.listContainer.style.display = '';
		}

		this.list.splice(0, this.list.length, servers);
	}

	/**
	 * Layouts the widget.
	 */
	layout(height: number, width: number): void {
		const sectionHeaderHeight = this.sectionHeader.offsetHeight || 100;
		const listHeight = height - sectionHeaderHeight - 24; // Extra padding

		this.listContainer.style.height = `${listHeight}px`;
		this.list.layout(listHeight, width);
	}

	/**
	 * Focuses the list.
	 */
	focus(): void {
		this.list.domFocus();
		const servers = this.list.length;
		if (servers > 0) {
			this.list.setFocus([0]);
		}
	}
}
