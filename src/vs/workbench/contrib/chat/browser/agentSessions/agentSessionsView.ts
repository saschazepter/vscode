/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSessionsView.css';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IViewContainersRegistry, IViewDescriptor, IViewDescriptorService, IViewsRegistry, ViewContainer, ViewContainerLocation, Extensions as ViewExtensions } from '../../../../common/views.js';
import { ViewPane, IViewPaneOptions } from '../../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IListVirtualDelegate, IIdentityProvider } from '../../../../../base/browser/ui/list/list.js';
import { IAsyncDataSource, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { WorkbenchAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { $, append } from '../../../../../base/browser/dom.js';
import { IAgentSession, IAgentSessionsModel } from './agentSessionsModel.js';
import { IAgentSessionsService } from './agentSessionsService.js';
import { IconLabel } from '../../../../../base/browser/ui/iconLabel/iconLabel.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';

// --- Constants

const agentSessionsViewIcon = registerIcon('agent-sessions-view-icon', Codicon.folder, localize('agentSessionsViewIcon', 'View icon of the agent sessions view.'));

export const AGENT_SESSIONS_VIEW_CONTAINER_ID = 'workbench.view.agentSessions';
export const AGENT_SESSIONS_VIEW_ID = 'workbench.view.agentSessions.folders';

// --- Tree Element Types

interface IAddFolderElement {
	readonly type: 'addFolder';
}

interface IWorkspaceFolderElement {
	readonly type: 'folder';
	readonly folder: IWorkspaceFolder;
}

type AgentSessionsTreeElement = IAddFolderElement | IWorkspaceFolderElement | IAgentSession;

function isAddFolderElement(element: AgentSessionsTreeElement | undefined): element is IAddFolderElement {
	return (element as IAddFolderElement | undefined)?.type === 'addFolder';
}

function isWorkspaceFolderElement(element: AgentSessionsTreeElement): element is IWorkspaceFolderElement {
	return (element as IWorkspaceFolderElement).type === 'folder';
}

function isAgentSession(element: AgentSessionsTreeElement): element is IAgentSession {
	return 'resource' in element && 'label' in element;
}

// --- Tree List Delegate

class AgentSessionsListDelegate implements IListVirtualDelegate<AgentSessionsTreeElement> {

	getHeight(element: AgentSessionsTreeElement): number {
		if (isAddFolderElement(element)) {
			return 28;
		}
		return 22;
	}

	getTemplateId(element: AgentSessionsTreeElement): string {
		if (isAddFolderElement(element)) {
			return AddFolderRenderer.TEMPLATE_ID;
		}
		if (isWorkspaceFolderElement(element)) {
			return WorkspaceFolderRenderer.TEMPLATE_ID;
		}
		return AgentSessionRenderer.TEMPLATE_ID;
	}
}

// --- Tree Identity Provider

class AgentSessionsIdentityProvider implements IIdentityProvider<AgentSessionsTreeElement> {

	getId(element: AgentSessionsTreeElement): string {
		if (isAddFolderElement(element)) {
			return 'addFolder';
		}
		if (isWorkspaceFolderElement(element)) {
			return `folder:${element.folder.uri.toString()}`;
		}
		return `session:${element.resource.toString()}`;
	}
}

// --- Tree Renderers

interface IAddFolderTemplate {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
}

class AddFolderRenderer implements ITreeRenderer<IAddFolderElement, void, IAddFolderTemplate> {

	static readonly TEMPLATE_ID = 'addFolder';

	get templateId(): string { return AddFolderRenderer.TEMPLATE_ID; }

	renderTemplate(container: HTMLElement): IAddFolderTemplate {
		const element = append(container, $('.agent-sessions-add-folder'));
		const icon = append(element, $('.icon' + ThemeIcon.asCSSSelector(Codicon.add)));
		const label = append(element, $('.label'));
		label.textContent = localize('addFolder', "Add Folder");
		return { container: element, icon, label };
	}

	renderElement(_node: ITreeNode<IAddFolderElement, void>, _index: number, _templateData: IAddFolderTemplate): void {
		// Static content, nothing to update
	}

	disposeTemplate(_templateData: IAddFolderTemplate): void {
		// Nothing to dispose
	}
}

interface IWorkspaceFolderTemplate {
	readonly icon: HTMLElement;
	readonly label: IconLabel;
	readonly disposables: DisposableStore;
}

class WorkspaceFolderRenderer implements ITreeRenderer<IWorkspaceFolderElement, void, IWorkspaceFolderTemplate> {

	static readonly TEMPLATE_ID = 'workspaceFolder';

	get templateId(): string { return WorkspaceFolderRenderer.TEMPLATE_ID; }

	renderTemplate(container: HTMLElement): IWorkspaceFolderTemplate {
		const element = append(container, $('.agent-sessions-folder'));
		const icon = append(element, $('.icon'));
		const label = new IconLabel(element, { supportHighlights: false });
		return { icon, label, disposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<IWorkspaceFolderElement, void>, _index: number, templateData: IWorkspaceFolderTemplate): void {
		const folder = node.element.folder;
		templateData.icon.className = `icon ${ThemeIcon.asClassName(Codicon.folder)}`;
		templateData.label.setLabel(folder.name);
	}

	disposeElement(_element: ITreeNode<IWorkspaceFolderElement, void>, _index: number, templateData: IWorkspaceFolderTemplate): void {
		templateData.disposables.clear();
	}

	disposeTemplate(templateData: IWorkspaceFolderTemplate): void {
		templateData.disposables.dispose();
		templateData.label.dispose();
	}
}

interface IAgentSessionTemplate {
	readonly icon: HTMLElement;
	readonly label: IconLabel;
	readonly disposables: DisposableStore;
}

class AgentSessionRenderer implements ITreeRenderer<IAgentSession, void, IAgentSessionTemplate> {

	static readonly TEMPLATE_ID = 'agentSession';

	get templateId(): string { return AgentSessionRenderer.TEMPLATE_ID; }

	renderTemplate(container: HTMLElement): IAgentSessionTemplate {
		const element = append(container, $('.agent-sessions-session'));
		const icon = append(element, $('.icon'));
		const label = new IconLabel(element, { supportHighlights: false });
		return { icon, label, disposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<IAgentSession, void>, _index: number, templateData: IAgentSessionTemplate): void {
		const session = node.element;
		templateData.icon.className = `icon ${ThemeIcon.asClassName(session.icon)}`;
		templateData.label.setLabel(session.label, typeof session.description === 'string' ? session.description : session.description?.value);
	}

	disposeElement(_element: ITreeNode<IAgentSession, void>, _index: number, templateData: IAgentSessionTemplate): void {
		templateData.disposables.clear();
	}

	disposeTemplate(templateData: IAgentSessionTemplate): void {
		templateData.disposables.dispose();
		templateData.label.dispose();
	}
}

// --- Tree Data Source

class AgentSessionsDataSource implements IAsyncDataSource<IAgentSessionsModel, AgentSessionsTreeElement> {

	constructor(
		private readonly workspaceContextService: IWorkspaceContextService,
		private readonly agentSessionsModel: IAgentSessionsModel
	) { }

	hasChildren(element: IAgentSessionsModel | AgentSessionsTreeElement): boolean {
		if (this.isModel(element)) {
			return true; // Model always has children (add folder button + folders)
		}
		if (isWorkspaceFolderElement(element)) {
			return this.agentSessionsModel.sessions.length > 0; // Folders have children if there are sessions
		}
		return false;
	}

	async getChildren(element: IAgentSessionsModel | AgentSessionsTreeElement): Promise<AgentSessionsTreeElement[]> {
		if (this.isModel(element)) {
			const result: AgentSessionsTreeElement[] = [];

			// Add "Add Folder" button at the top
			result.push({ type: 'addFolder' });

			// Add workspace folders
			const folders = this.workspaceContextService.getWorkspace().folders;
			for (const folder of folders) {
				result.push({ type: 'folder', folder });
			}

			return result;
		}

		if (isWorkspaceFolderElement(element)) {
			// Return all sessions sorted by date (newest first)
			// TODO: Filter sessions by folder once sessions have folder association
			return [...this.agentSessionsModel.sessions].sort((a, b) => {
				const timeA = a.timing.created ?? 0;
				const timeB = b.timing.created ?? 0;
				return timeB - timeA;
			});
		}

		return [];
	}

	private isModel(element: IAgentSessionsModel | AgentSessionsTreeElement): element is IAgentSessionsModel {
		return 'sessions' in element && 'getSession' in element;
	}
}

// --- View Pane

export class AgentSessionsViewPane extends ViewPane {

	private tree!: WorkbenchAsyncDataTree<IAgentSessionsModel, AgentSessionsTreeElement>;
	private readonly visibilityDisposables = this._register(new DisposableStore());

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
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ICommandService private readonly commandService: ICommandService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const treeContainer = append(container, $('.agent-sessions-view'));

		this.createTree(treeContainer);

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.onVisible();
			} else {
				this.visibilityDisposables.clear();
			}
		}));
	}

	private createTree(container: HTMLElement): void {
		const dataSource = new AgentSessionsDataSource(this.workspaceContextService, this.agentSessionsService.model);

		this.tree = this.instantiationService.createInstance(
			WorkbenchAsyncDataTree,
			'AgentSessionsView',
			container,
			new AgentSessionsListDelegate(),
			[
				new AddFolderRenderer(),
				new WorkspaceFolderRenderer(),
				new AgentSessionRenderer(),
			],
			dataSource,
			{
				identityProvider: new AgentSessionsIdentityProvider(),
				horizontalScrolling: false,
				accessibilityProvider: {
					getAriaLabel(element: AgentSessionsTreeElement): string {
						if (isAddFolderElement(element)) {
							return localize('addFolder', "Add Folder");
						}
						if (isWorkspaceFolderElement(element)) {
							return element.folder.name;
						}
						if (isAgentSession(element)) {
							return element.label;
						}
						return '';
					},
					getWidgetAriaLabel() {
						return localize('agentSessionsView', "Agent Sessions");
					}
				},
				overrideStyles: this.getLocationBasedColors().listOverrideStyles,
			}
		) as WorkbenchAsyncDataTree<IAgentSessionsModel, AgentSessionsTreeElement>;

		this._register(this.tree);

		this._register(this.tree.onDidOpen(e => {
			if (isAddFolderElement(e.element)) {
				this.addFolder();
			}
		}));
	}

	private onVisible(): void {
		// Set initial input
		this.tree.setInput(this.agentSessionsService.model);

		// Listen for workspace folder changes
		this.visibilityDisposables.add(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this.tree.updateChildren();
		}));

		// Listen for session changes
		this.visibilityDisposables.add(this.agentSessionsService.model.onDidChangeSessions(() => {
			this.tree.updateChildren();
		}));
	}

	private addFolder(): void {
		this.commandService.executeCommand('workbench.action.addRootFolder');
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}

	override focus(): void {
		super.focus();
		this.tree?.domFocus();
	}
}

// --- View Container & View Registration

console.log('[AgentSessionsView] Registering view container and view for AgentSessionsSideBar');

const agentSessionsViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: AGENT_SESSIONS_VIEW_CONTAINER_ID,
	title: localize2('agentSessions.viewContainer.label', "Agent Sessions"),
	icon: agentSessionsViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AGENT_SESSIONS_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: AGENT_SESSIONS_VIEW_CONTAINER_ID,
	hideIfEmpty: false,
	order: 1,
	showInAgentSessions: true,
}, ViewContainerLocation.Sidebar);

const agentSessionsViewDescriptor: IViewDescriptor = {
	id: AGENT_SESSIONS_VIEW_ID,
	containerIcon: agentSessionsViewContainer.icon,
	containerTitle: agentSessionsViewContainer.title.value,
	singleViewPaneContainerTitle: agentSessionsViewContainer.title.value,
	name: localize2('agentSessions.view.label', "Folders"),
	canToggleVisibility: false,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(AgentSessionsViewPane),
	showInAgentSessions: true,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([agentSessionsViewDescriptor], agentSessionsViewContainer);
