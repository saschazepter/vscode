/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/changesView.css';
import * as dom from '../../../../base/browser/dom.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Iterable } from '../../../../base/common/iterator.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableFromEvent, observableValue } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/path.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { MenuWorkbenchButtonBar } from '../../../../platform/actions/browser/buttonbar.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { bindContextKey } from '../../../../platform/observable/common/platformObservableUtils.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { fillEditorsDragData } from '../../../browser/dnd.js';
import { IResourceLabel, ResourceLabels } from '../../../browser/labels.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IChatWidgetService } from '../../../contrib/chat/browser/chat.js';
import { IAgentSessionsService } from '../../../contrib/chat/browser/agentSessions/agentSessionsService.js';
import { AgentSessionProviders } from '../../../contrib/chat/browser/agentSessions/agentSessions.js';
import { ChatContextKeys } from '../../../contrib/chat/common/actions/chatContextKeys.js';
import { isIChatSessionFileChange2 } from '../../../contrib/chat/common/chatSessionsService.js';
import { chatEditingWidgetFileStateContextKey, hasAppliedChatEditsContextKey, hasUndecidedChatEditingResourceContextKey, IChatEditingService, ModifiedFileEntryState } from '../../../contrib/chat/common/editing/chatEditingService.js';
import { getChatSessionType } from '../../../contrib/chat/common/model/chatUri.js';
import { createFileIconThemableTreeContainerScope } from '../../../contrib/files/browser/views/explorerView.js';
import { IActivityService, NumberBadge } from '../../../services/activity/common/activity.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';

const $ = dom.$;

// --- Constants

export const CHANGES_VIEW_CONTAINER_ID = 'workbench.view.agentSessions.changesContainer';
export const CHANGES_VIEW_ID = 'workbench.view.agentSessions.changes';

// --- List Item

type ChangeType = 'added' | 'modified' | 'deleted';

interface IChangesListItem {
	readonly uri: URI;
	readonly originalUri?: URI;
	readonly state: ModifiedFileEntryState;
	readonly isDeletion: boolean;
	readonly changeType: ChangeType;
	readonly linesAdded: number;
	readonly linesRemoved: number;
}

// --- View Pane

export class ChangesViewPane extends ViewPane {

	private bodyContainer: HTMLElement | undefined;
	private welcomeContainer: HTMLElement | undefined;
	private contentContainer: HTMLElement | undefined;
	private overviewContainer: HTMLElement | undefined;
	private summaryContainer: HTMLElement | undefined;
	private listContainer: HTMLElement | undefined;
	// Actions container is positioned outside the card for this layout experiment
	private actionsContainer: HTMLElement | undefined;

	private list: WorkbenchList<IChangesListItem> | undefined;

	private readonly renderDisposables = this._register(new DisposableStore());

	// Track the active session's editing session resource
	private readonly activeSessionResource = observableValue<URI | undefined>(this, undefined);

	// Badge for file count
	private readonly badgeDisposable = this._register(new MutableDisposable());

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
		@IChatEditingService private readonly chatEditingService: IChatEditingService,
		@IEditorService private readonly editorService: IEditorService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IActivityService private readonly activityService: IActivityService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@ILabelService private readonly labelService: ILabelService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Setup badge tracking
		this.registerBadgeTracking();

		// Track active session from focused chat widgets
		this.registerActiveSessionTracking();
	}

	private registerActiveSessionTracking(): void {
		// Initialize with the last focused widget's session if available
		const lastFocused = this.chatWidgetService.lastFocusedWidget;
		if (lastFocused?.viewModel?.sessionResource) {
			this.activeSessionResource.set(lastFocused.viewModel.sessionResource, undefined);
		}

		// Listen for new widgets and track their focus
		this._register(this.chatWidgetService.onDidAddWidget(widget => {
			this._register(widget.onDidFocus(() => {
				if (widget.viewModel?.sessionResource) {
					this.activeSessionResource.set(widget.viewModel.sessionResource, undefined);
				}
			}));

			// Also track view model changes (when a widget loads a different session)
			this._register(widget.onDidChangeViewModel(({ currentSessionResource }) => {
				// Only update if this widget is focused
				if (this.chatWidgetService.lastFocusedWidget === widget && currentSessionResource) {
					this.activeSessionResource.set(currentSessionResource, undefined);
				}
			}));
		}));

		// Track focus changes on existing widgets
		for (const widget of this.chatWidgetService.getAllWidgets()) {
			this._register(widget.onDidFocus(() => {
				if (widget.viewModel?.sessionResource) {
					this.activeSessionResource.set(widget.viewModel.sessionResource, undefined);
				}
			}));

			this._register(widget.onDidChangeViewModel(({ currentSessionResource }) => {
				if (this.chatWidgetService.lastFocusedWidget === widget && currentSessionResource) {
					this.activeSessionResource.set(currentSessionResource, undefined);
				}
			}));
		}
	}

	private registerBadgeTracking(): void {
		// Observable for session file changes from agentSessionsService (cloud/background sessions)
		const sessionFileChangesObs = observableFromEvent(
			this,
			this.agentSessionsService.model.onDidChangeSessions,
			() => {
				const sessionResource = this.activeSessionResource.get();
				if (!sessionResource) {
					return Iterable.empty();
				}
				const model = this.agentSessionsService.getSession(sessionResource);
				return model?.changes instanceof Array ? model.changes : Iterable.empty();
			},
		);

		// Create observable for the number of files changed in the active session
		// Combines both editing session entries and session file changes (for cloud/background sessions)
		const fileCountObs = derived(reader => {
			const sessionResource = this.activeSessionResource.read(reader);
			if (!sessionResource) {
				return 0;
			}

			// Background chat sessions render the working set based on the session files, not the editing session
			const isBackgroundSession = getChatSessionType(sessionResource) === AgentSessionProviders.Background;

			// Count from editing session entries (skip for background sessions)
			let editingSessionCount = 0;
			if (!isBackgroundSession) {
				const sessions = this.chatEditingService.editingSessionsObs.read(reader);
				const session = sessions.find(candidate => isEqual(candidate.chatSessionResource, sessionResource));
				editingSessionCount = session ? session.entries.read(reader).length : 0;
			}

			// Count from session file changes (cloud/background sessions)
			const sessionFiles = [...sessionFileChangesObs.read(reader)];
			const sessionFilesCount = sessionFiles.length;

			return editingSessionCount + sessionFilesCount;
		});

		// Update badge when file count changes
		this._register(autorun(reader => {
			const fileCount = fileCountObs.read(reader);
			this.updateBadge(fileCount);
		}));
	}

	private updateBadge(fileCount: number): void {
		if (fileCount > 0) {
			const message = fileCount === 1
				? localize('changesView.oneFileChanged', '1 file changed')
				: localize('changesView.filesChanged', '{0} files changed', fileCount);
			this.badgeDisposable.value = this.activityService.showViewActivity(CHANGES_VIEW_ID, { badge: new NumberBadge(fileCount, () => message) });
		} else {
			this.badgeDisposable.clear();
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.bodyContainer = dom.append(container, $('.changes-view-body'));

		// Welcome message for empty state
		this.welcomeContainer = dom.append(this.bodyContainer, $('.changes-welcome'));
		const welcomeIcon = dom.append(this.welcomeContainer, $('.changes-welcome-icon'));
		welcomeIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.diffMultiple));
		const welcomeMessage = dom.append(this.welcomeContainer, $('.changes-welcome-message'));
		welcomeMessage.textContent = localize('changesView.noChanges', "No files have been changed.");

		// Actions container - positioned outside and above the card
		this.actionsContainer = dom.append(this.bodyContainer, $('.chat-editing-session-actions.outside-card'));

		// Main container with file icons support (the "card")
		this.contentContainer = dom.append(this.bodyContainer, $('.chat-editing-session-container.show-file-icons'));
		this._register(createFileIconThemableTreeContainerScope(this.contentContainer, this.themeService));

		// Toggle class based on whether the file icon theme has file icons
		const updateHasFileIcons = () => {
			this.contentContainer!.classList.toggle('has-file-icons', this.themeService.getFileIconTheme().hasFileIcons);
		};
		updateHasFileIcons();
		this._register(this.themeService.onDidFileIconThemeChange(updateHasFileIcons));

		// Overview section (header with summary only - actions moved outside card)
		this.overviewContainer = dom.append(this.contentContainer, $('.chat-editing-session-overview'));
		this.summaryContainer = dom.append(this.overviewContainer, $('.changes-summary'));

		// List container
		this.listContainer = dom.append(this.contentContainer, $('.chat-editing-session-list'));

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.onVisible();
			} else {
				this.renderDisposables.clear();
			}
		}));

		// Trigger initial render if already visible
		if (this.isBodyVisible()) {
			this.onVisible();
		}
	}

	private onVisible(): void {
		this.renderDisposables.clear();

		// Create observable for the active editing session
		// Note: We must read editingSessionsObs to establish a reactive dependency,
		// so that the view updates when a new editing session is added (e.g., cloud sessions)
		const activeEditingSessionObs = derived(reader => {
			const sessionResource = this.activeSessionResource.read(reader);
			if (!sessionResource) {
				return undefined;
			}
			const sessions = this.chatEditingService.editingSessionsObs.read(reader);
			return sessions.find(candidate => isEqual(candidate.chatSessionResource, sessionResource));
		});

		// Create observable for edit session entries from the ACTIVE session only (local editing sessions)
		const editSessionEntriesObs = derived(reader => {
			const sessionResource = this.activeSessionResource.read(reader);

			// Background chat sessions render the working set based on the session files, not the editing session
			if (sessionResource && getChatSessionType(sessionResource) === AgentSessionProviders.Background) {
				return [];
			}

			const session = activeEditingSessionObs.read(reader);
			if (!session) {
				return [];
			}

			const entries = session.entries.read(reader);
			const items: IChangesListItem[] = [];

			for (const entry of entries) {
				const isDeletion = entry.isDeletion ?? false;
				const linesAdded = entry.linesAdded?.read(reader) ?? 0;
				const linesRemoved = entry.linesRemoved?.read(reader) ?? 0;

				items.push({
					uri: entry.modifiedURI,
					originalUri: entry.originalURI,
					state: entry.state.read(reader),
					isDeletion,
					changeType: isDeletion ? 'deleted' : 'modified',
					linesAdded,
					linesRemoved,
				});
			}

			return items;
		});

		// Create observable for session file changes from agentSessionsService (cloud/background sessions)
		const sessionFileChangesObs = observableFromEvent(
			this.renderDisposables,
			this.agentSessionsService.model.onDidChangeSessions,
			() => {
				const sessionResource = this.activeSessionResource.get();
				if (!sessionResource) {
					return Iterable.empty();
				}
				const model = this.agentSessionsService.getSession(sessionResource);
				return model?.changes instanceof Array ? model.changes : Iterable.empty();
			},
		);

		// Convert session file changes to list items (cloud/background sessions)
		const sessionFilesObs = derived(reader =>
			[...sessionFileChangesObs.read(reader)].map((entry): IChangesListItem => {
				const isDeletion = entry.modifiedUri === undefined;
				const isAddition = entry.originalUri === undefined;
				return {
					uri: isIChatSessionFileChange2(entry)
						? entry.modifiedUri ?? entry.uri
						: entry.modifiedUri,
					originalUri: entry.originalUri,
					state: ModifiedFileEntryState.Accepted,
					isDeletion,
					changeType: isDeletion ? 'deleted' : isAddition ? 'added' : 'modified',
					linesAdded: entry.insertions,
					linesRemoved: entry.deletions,
				};
			})
		);

		// Combine both entry sources for display
		const combinedEntriesObs = derived(reader => {
			const editEntries = editSessionEntriesObs.read(reader);
			const sessionFiles = sessionFilesObs.read(reader);
			return [...editEntries, ...sessionFiles];
		});

		// Calculate stats from combined entries
		const topLevelStats = derived(reader => {
			const editEntries = editSessionEntriesObs.read(reader);
			const sessionFiles = sessionFilesObs.read(reader);
			const entries = [...editEntries, ...sessionFiles];

			let added = 0, removed = 0;

			for (const entry of entries) {
				added += entry.linesAdded;
				removed += entry.linesRemoved;
			}

			const files = entries.length;
			const isSessionMenu = editEntries.length === 0 && sessionFiles.length > 0;

			return { files, added, removed, isSessionMenu };
		});

		// Setup context keys and actions toolbar
		if (this.actionsContainer) {
			dom.clearNode(this.actionsContainer);

			const scopedContextKeyService = this.renderDisposables.add(this.contextKeyService.createScoped(this.actionsContainer));
			const scopedInstantiationService = this.renderDisposables.add(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, scopedContextKeyService])));

			// Bind required context keys for the menu buttons
			this.renderDisposables.add(bindContextKey(hasUndecidedChatEditingResourceContextKey, scopedContextKeyService, r => {
				const session = activeEditingSessionObs.read(r);
				if (!session) {
					return false;
				}
				const entries = session.entries.read(r);
				return entries.some(entry => entry.state.read(r) === ModifiedFileEntryState.Modified);
			}));

			this.renderDisposables.add(bindContextKey(hasAppliedChatEditsContextKey, scopedContextKeyService, r => {
				const session = activeEditingSessionObs.read(r);
				if (!session) {
					return false;
				}
				const entries = session.entries.read(r);
				return entries.length > 0;
			}));

			this.renderDisposables.add(bindContextKey(ChatContextKeys.hasAgentSessionChanges, scopedContextKeyService, r => {
				const { files } = topLevelStats.read(r);
				return files > 0;
			}));

			this.renderDisposables.add(autorun(reader => {
				const { isSessionMenu, added, removed } = topLevelStats.read(reader);
				const sessionResource = this.activeSessionResource.read(reader);
				reader.store.add(scopedInstantiationService.createInstance(
					MenuWorkbenchButtonBar,
					this.actionsContainer!,
					isSessionMenu ? MenuId.ChatEditingSessionChangesToolbar : MenuId.ChatEditingWidgetToolbar,
					{
						telemetrySource: 'changesView',
						menuOptions: isSessionMenu && sessionResource
							? { args: [sessionResource, this.agentSessionsService.getSession(sessionResource)?.metadata] }
							: { shouldForwardArgs: true },
						buttonConfigProvider: (action) => {
							if (action.id === 'chatEditing.viewChanges' || action.id === 'chatEditing.viewPreviousEdits' || action.id === 'chatEditing.viewAllSessionChanges' || action.id === 'chat.openSessionWorktreeInVSCode') {
								const diffStatsLabel = new MarkdownString(
									`<span class="working-set-lines-added">+${added}</span>&nbsp;<span class="working-set-lines-removed">-${removed}</span>`,
									{ supportHtml: true }
								);
								return { showIcon: true, showLabel: true, isSecondary: true, customClass: 'working-set-diff-stats', customLabel: diffStatsLabel };
							}
							if (action.id === 'github.createPullRequest') {
								return { showIcon: true, showLabel: true };
							}
							return undefined;
						}
					}
				));
			}));
		}

		// Update visibility based on entries
		this.renderDisposables.add(autorun(reader => {
			const { files } = topLevelStats.read(reader);
			const hasEntries = files > 0;

			dom.setVisibility(hasEntries, this.contentContainer!);
			dom.setVisibility(hasEntries, this.actionsContainer!);
			dom.setVisibility(!hasEntries, this.welcomeContainer!);
		}));

		// Update summary text (line counts only, file count is shown in badge)
		if (this.summaryContainer) {
			dom.clearNode(this.summaryContainer);

			const linesAddedSpan = dom.$('.working-set-lines-added');
			const linesRemovedSpan = dom.$('.working-set-lines-removed');

			this.summaryContainer.appendChild(linesAddedSpan);
			this.summaryContainer.appendChild(linesRemovedSpan);

			this.renderDisposables.add(autorun(reader => {
				const { added, removed } = topLevelStats.read(reader);

				linesAddedSpan.textContent = `+${added}`;
				linesRemovedSpan.textContent = `-${removed}`;
			}));
		}

		// Create the list
		if (!this.list && this.listContainer) {
			const resourceLabels = this._register(this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: this.onDidChangeBodyVisibility }));
			this.list = this.instantiationService.createInstance(
				WorkbenchList<IChangesListItem>,
				'ChangesViewList',
				this.listContainer,
				new ChangesListDelegate(),
				[this.instantiationService.createInstance(ChangesListRenderer, resourceLabels, MenuId.ChatEditingWidgetModifiedFilesToolbar)],
				{
					verticalScrollMode: ScrollbarVisibility.Visible,
					alwaysConsumeMouseWheel: false,
					accessibilityProvider: {
						getAriaLabel: (element: IChangesListItem) => basename(element.uri.path),
						getWidgetAriaLabel: () => localize('changesViewList', "Changes List")
					},
					dnd: {
						getDragURI: (element: IChangesListItem) => element.uri.toString(),
						getDragLabel: (elements) => {
							const uris = elements.map(e => e.uri);
							if (uris.length === 1) {
								return this.labelService.getUriLabel(uris[0], { relative: true });
							}
							return `${uris.length}`;
						},
						dispose: () => { },
						onDragOver: () => false,
						drop: () => { },
						onDragStart: (data, originalEvent) => {
							try {
								const elements = data.getData() as IChangesListItem[];
								const uris = elements.map(e => e.uri);
								this.instantiationService.invokeFunction(accessor => fillEditorsDragData(accessor, uris, originalEvent));
							} catch {
								// noop
							}
						},
					},
				}
			);
		}

		// Register list event handlers
		if (this.list) {
			const list = this.list;

			this.renderDisposables.add(list.onDidOpen(async (e) => {
				if (!e.element) {
					return;
				}

				const { uri: modifiedFileUri, originalUri, isDeletion } = e.element;

				if (isDeletion && originalUri) {
					await this.editorService.openEditor({
						resource: originalUri,
						options: e.editorOptions
					}, e.sideBySide ? SIDE_GROUP : ACTIVE_GROUP);
					return;
				}

				if (originalUri) {
					await this.editorService.openEditor({
						original: { resource: originalUri },
						modified: { resource: modifiedFileUri },
						options: e.editorOptions
					}, e.sideBySide ? SIDE_GROUP : ACTIVE_GROUP);
					return;
				}

				await this.editorService.openEditor({
					resource: modifiedFileUri,
					options: e.editorOptions
				}, e.sideBySide ? SIDE_GROUP : ACTIVE_GROUP);
			}));
		}

		// Update list data with combined entries
		this.renderDisposables.add(autorun(reader => {
			const entries = combinedEntriesObs.read(reader);

			if (!this.list) {
				return;
			}

			const maxItemsShown = 6;
			const itemsShown = Math.min(entries.length, maxItemsShown);
			const height = itemsShown * 22;
			this.list.layout(height);
			this.list.getHTMLElement().style.height = `${height}px`;
			this.list.splice(0, this.list.length, entries);
		}));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	override focus(): void {
		super.focus();
		this.list?.domFocus();
	}

	override dispose(): void {
		this.list?.dispose();
		this.list = undefined;
		super.dispose();
	}
}

export class ChangesViewPaneContainer extends ViewPaneContainer {
	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExtensionService extensionService: IExtensionService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@ILogService logService: ILogService,
	) {
		super(CHANGES_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }, instantiationService, configurationService, layoutService, contextMenuService, telemetryService, extensionService, themeService, storageService, contextService, viewDescriptorService, logService);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		parent.classList.add('changes-viewlet');
	}
}

// --- List Delegate & Renderer

class ChangesListDelegate implements IListVirtualDelegate<IChangesListItem> {
	getHeight(_element: IChangesListItem): number {
		return 22;
	}

	getTemplateId(_element: IChangesListItem): string {
		return ChangesListRenderer.TEMPLATE_ID;
	}
}

interface IChangesListTemplate {
	readonly label: IResourceLabel;
	readonly templateDisposables: DisposableStore;
	readonly toolbar: MenuWorkbenchToolBar | undefined;
	readonly contextKeyService: IContextKeyService | undefined;
	readonly decorationBadge: HTMLElement;
	readonly addedSpan: HTMLElement;
	readonly removedSpan: HTMLElement;
}

class ChangesListRenderer implements IListRenderer<IChangesListItem, IChangesListTemplate> {
	static TEMPLATE_ID = 'changesListRenderer';
	readonly templateId: string = ChangesListRenderer.TEMPLATE_ID;

	constructor(
		private labels: ResourceLabels,
		private menuId: MenuId | undefined,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) { }

	renderTemplate(container: HTMLElement): IChangesListTemplate {
		const templateDisposables = new DisposableStore();
		const label = templateDisposables.add(this.labels.create(container, { supportHighlights: true, supportIcons: true }));

		const fileDiffsContainer = $('.working-set-line-counts');
		const addedSpan = dom.$('.working-set-lines-added');
		const removedSpan = dom.$('.working-set-lines-removed');
		fileDiffsContainer.appendChild(addedSpan);
		fileDiffsContainer.appendChild(removedSpan);
		label.element.appendChild(fileDiffsContainer);

		const decorationBadge = dom.$('.changes-decoration-badge');
		label.element.appendChild(decorationBadge);

		let toolbar: MenuWorkbenchToolBar | undefined;
		let contextKeyService: IContextKeyService | undefined;
		if (this.menuId) {
			const actionBarContainer = $('.chat-collapsible-list-action-bar');
			contextKeyService = templateDisposables.add(this.contextKeyService.createScoped(actionBarContainer));
			const scopedInstantiationService = templateDisposables.add(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, contextKeyService])));
			toolbar = templateDisposables.add(scopedInstantiationService.createInstance(MenuWorkbenchToolBar, actionBarContainer, this.menuId, { menuOptions: { shouldForwardArgs: true, arg: undefined } }));
			label.element.appendChild(actionBarContainer);
		}

		return { templateDisposables, label, toolbar, contextKeyService, decorationBadge, addedSpan, removedSpan };
	}

	renderElement(data: IChangesListItem, _index: number, templateData: IChangesListTemplate): void {
		templateData.label.element.style.display = 'flex';

		templateData.label.setFile(data.uri, {
			fileKind: FileKind.FILE,
			fileDecorations: undefined,
			strikethrough: data.changeType === 'deleted',
		});

		// Update decoration badge (A/M/D)
		const badge = templateData.decorationBadge;
		badge.className = 'changes-decoration-badge';
		switch (data.changeType) {
			case 'added':
				badge.textContent = 'A';
				badge.classList.add('added');
				break;
			case 'deleted':
				badge.textContent = 'D';
				badge.classList.add('deleted');
				break;
			case 'modified':
			default:
				badge.textContent = 'M';
				badge.classList.add('modified');
				break;
		}

		templateData.addedSpan.textContent = `+${data.linesAdded}`;
		templateData.removedSpan.textContent = `-${data.linesRemoved}`;

		// eslint-disable-next-line no-restricted-syntax
		templateData.label.element.querySelector('.monaco-icon-name-container')?.classList.add('modified');

		if (templateData.toolbar) {
			templateData.toolbar.context = data.uri;
		}
		if (templateData.contextKeyService) {
			chatEditingWidgetFileStateContextKey.bindTo(templateData.contextKeyService).set(data.state);
		}
	}

	disposeTemplate(templateData: IChangesListTemplate): void {
		templateData.templateDisposables.dispose();
	}
}
