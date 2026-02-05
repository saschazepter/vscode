/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/mcpManagementEditor.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { McpManagementEditorInput } from './mcpManagementEditorInput.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IMcpWorkbenchService, IWorkbenchMcpServer, McpConnectionState, IMcpService } from '../../../mcp/common/mcpTypes.js';
import { localize } from '../../../../../nls.js';
import { IListVirtualDelegate, IListRenderer } from '../../../../../base/browser/ui/list/list.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { McpCommandIds } from '../../../mcp/common/mcpCommandIds.js';
import { autorun } from '../../../../../base/common/observable.js';

const $ = DOM.$;

export class McpManagementEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.mcpManagement';

	private readonly editorDisposables = this._register(new DisposableStore());
	private dimension: Dimension | undefined;
	private bodyContainer: HTMLElement | undefined;
	private serversList: WorkbenchList<IWorkbenchMcpServer> | undefined;
	private emptyContainer: HTMLElement | undefined;
	private listContainer: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IMcpWorkbenchService private readonly mcpWorkbenchService: IMcpWorkbenchService,
		@IMcpService private readonly mcpService: IMcpService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(McpManagementEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		this.bodyContainer = DOM.append(parent, $('.mcp-management-editor'));

		// Header
		const header = DOM.append(this.bodyContainer, $('.mcp-management-header'));
		const headerTitle = DOM.append(header, $('.mcp-management-header-title'));
		headerTitle.textContent = localize('mcpServers', "MCP Servers");

		// Add configuration button in header
		const headerActions = DOM.append(header, $('.mcp-management-header-actions'));
		const addButton = this.editorDisposables.add(new Button(headerActions, { ...defaultButtonStyles, secondary: true }));
		addButton.label = localize('addConfiguration', "Add Configuration");
		this.editorDisposables.add(addButton.onDidClick(() => {
			this.commandService.executeCommand(McpCommandIds.AddConfiguration);
		}));

		// Empty state
		this.emptyContainer = DOM.append(this.bodyContainer, $('.mcp-management-empty'));
		const emptyIcon = DOM.append(this.emptyContainer, $('.empty-icon'));
		emptyIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.server));
		const emptyText = DOM.append(this.emptyContainer, $('.empty-text'));
		emptyText.textContent = localize('noMcpServers', "No MCP servers configured");
		const emptySubtext = DOM.append(this.emptyContainer, $('.empty-subtext'));
		emptySubtext.textContent = localize('addMcpServer', "Add an MCP server configuration to get started");

		const emptyButton = this.editorDisposables.add(new Button(this.emptyContainer, { ...defaultButtonStyles }));
		emptyButton.label = localize('addConfiguration', "Add Configuration");
		this.editorDisposables.add(emptyButton.onDidClick(() => {
			this.commandService.executeCommand(McpCommandIds.AddConfiguration);
		}));

		// List container
		this.listContainer = DOM.append(this.bodyContainer, $('.mcp-management-list-container'));

		// Create list
		const delegate = new McpServerItemDelegate();
		const renderer = this.instantiationService.createInstance(McpServerItemRenderer);

		this.serversList = this.editorDisposables.add(this.instantiationService.createInstance(
			WorkbenchList<IWorkbenchMcpServer>,
			'McpManagementServers',
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

		this.editorDisposables.add(this.serversList.onDidOpen(e => {
			if (e.element) {
				this.mcpWorkbenchService.open(e.element);
			}
		}));

		// Listen to MCP service changes
		this.editorDisposables.add(this.mcpWorkbenchService.onChange(() => this.refresh()));
		this.editorDisposables.add(autorun(reader => {
			this.mcpService.servers.read(reader);
			this.refresh();
		}));
	}

	private async refresh(): Promise<void> {
		const servers = await this.mcpWorkbenchService.queryLocal();

		if (this.emptyContainer && this.listContainer) {
			if (servers.length === 0) {
				this.emptyContainer.style.display = 'flex';
				this.listContainer.style.display = 'none';
			} else {
				this.emptyContainer.style.display = 'none';
				this.listContainer.style.display = '';
			}
		}

		if (this.serversList) {
			this.serversList.splice(0, this.serversList.length, servers);
		}
	}

	override async setInput(input: McpManagementEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this.refresh();
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		if (this.bodyContainer && this.serversList && this.listContainer) {
			const headerHeight = 60; // header height
			const listHeight = dimension.height - headerHeight - 20;
			this.serversList.layout(listHeight, this.listContainer.clientWidth);
		}
	}

	override focus(): void {
		super.focus();
		this.serversList?.domFocus();
	}
}

class McpServerItemDelegate implements IListVirtualDelegate<IWorkbenchMcpServer> {
	getHeight(element: IWorkbenchMcpServer) {
		return 60;
	}
	getTemplateId() {
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
