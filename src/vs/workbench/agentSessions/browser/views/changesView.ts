/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/changesView.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableFromEvent, observableValue } from '../../../../base/common/observable.js';
import { IActivityService, NumberBadge } from '../../../services/activity/common/activity.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { Iterable } from '../../../../base/common/iterator.js';
import { localize } from '../../../../nls.js';
import { MenuWorkbenchButtonBar } from '../../../../platform/actions/browser/buttonbar.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { bindContextKey } from '../../../../platform/observable/common/platformObservableUtils.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ChatContextKeys } from '../../../contrib/chat/common/actions/chatContextKeys.js';
import { hasAppliedChatEditsContextKey, hasUndecidedChatEditingResourceContextKey, IChatEditingService, ModifiedFileEntryState } from '../../../contrib/chat/common/editing/chatEditingService.js';
import { CollapsibleListPool, IChatCollapsibleListItem } from '../../../contrib/chat/browser/widget/chatContentParts/chatReferencesContentPart.js';
import { createFileIconThemableTreeContainerScope } from '../../../contrib/files/browser/views/explorerView.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { URI } from '../../../../base/common/uri.js';
import { IChatWidgetService } from '../../../contrib/chat/browser/chat.js';
import { isEqual } from '../../../../base/common/resources.js';
import { IAgentSessionsService } from '../../../contrib/chat/browser/agentSessions/agentSessionsService.js';
import { isIChatSessionFileChange2 } from '../../../contrib/chat/common/chatSessionsService.js';

const $ = dom.$;

// --- Constants

export const CHANGES_VIEW_CONTAINER_ID = 'workbench.view.agentSessions.changesContainer';
export const CHANGES_VIEW_ID = 'workbench.view.agentSessions.changes';

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

	private readonly listPool: CollapsibleListPool;
	private listRef: { object: import('../../../../platform/list/browser/listService.js').WorkbenchList<IChatCollapsibleListItem>; dispose(): void } | undefined;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Setup badge tracking
		this.registerBadgeTracking();

		// Create the list pool
		this.listPool = this._register(this.instantiationService.createInstance(
			CollapsibleListPool,
			this.onDidChangeBodyVisibility,
			MenuId.ChatEditingWidgetModifiedFilesToolbar,
			{ verticalScrollMode: ScrollbarVisibility.Visible }
		));

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

			// Count from editing session entries
			const sessions = this.chatEditingService.editingSessionsObs.read(reader);
			const session = sessions.find(candidate => isEqual(candidate.chatSessionResource, sessionResource));
			const editingSessionCount = session ? session.entries.read(reader).length : 0;

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
			const session = activeEditingSessionObs.read(reader);
			if (!session) {
				return [];
			}

			const entries = session.entries.read(reader);
			const items: IChatCollapsibleListItem[] = [];

			for (const entry of entries) {
				const state = entry.state.read(reader);

				const linesAdded = entry.linesAdded?.read(reader) ?? 0;
				const linesRemoved = entry.linesRemoved?.read(reader) ?? 0;

				items.push({
					reference: entry.modifiedURI,
					state: state,
					kind: 'reference',
					options: {
						diffMeta: { added: linesAdded, removed: linesRemoved },
						isDeletion: entry.isDeletion,
						originalUri: entry.originalURI,
						status: undefined
					}
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
			[...sessionFileChangesObs.read(reader)].map((entry): IChatCollapsibleListItem => ({
				reference: isIChatSessionFileChange2(entry)
					? entry.modifiedUri ?? entry.uri
					: entry.modifiedUri,
				state: ModifiedFileEntryState.Accepted,
				kind: 'reference',
				options: {
					diffMeta: { added: entry.insertions, removed: entry.deletions },
					isDeletion: entry.modifiedUri === undefined,
					originalUri: entry.originalUri,
					status: undefined
				}
			}))
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
				if (entry.kind === 'reference' && entry.options?.diffMeta) {
					added += entry.options.diffMeta.added;
					removed += entry.options.diffMeta.removed;
				}
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
				const { isSessionMenu } = topLevelStats.read(reader);
				const sessionResource = this.activeSessionResource.read(reader);
				reader.store.add(scopedInstantiationService.createInstance(
					MenuWorkbenchButtonBar,
					this.actionsContainer!,
					isSessionMenu ? MenuId.ChatEditingSessionChangesToolbar : MenuId.ChatEditingWidgetToolbar,
					{
						telemetrySource: 'changesView',
						menuOptions: isSessionMenu && sessionResource
							? { args: [sessionResource] }
							: { shouldForwardArgs: true },
						buttonConfigProvider: (action) => {
							if (action.id === 'chatEditing.viewChanges' || action.id === 'chatEditing.viewPreviousEdits' || action.id === 'chatEditing.viewAllSessionChanges') {
								return { showIcon: true, showLabel: false, isSecondary: true };
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

		// Create or reuse list
		if (!this.listRef && this.listContainer) {
			this.listRef = this.listPool.get();
			dom.append(this.listContainer, this.listRef.object.getHTMLElement());
		}

		// Register list event handlers
		if (this.listRef) {
			const list = this.listRef.object;

			this.renderDisposables.add(list.onDidOpen(async (e) => {
				if (e.element?.kind === 'reference' && URI.isUri(e.element.reference)) {
					const modifiedFileUri = e.element.reference;
					const originalUri = e.element.options?.originalUri;

					if (e.element.options?.isDeletion && originalUri) {
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
				}
			}));
		}

		// Update list data with combined entries
		this.renderDisposables.add(autorun(reader => {
			const entries = combinedEntriesObs.read(reader);

			if (!this.listRef) {
				return;
			}

			const maxItemsShown = 6;
			const itemsShown = Math.min(entries.length, maxItemsShown);
			const height = itemsShown * 22;
			const list = this.listRef.object;
			list.layout(height);
			list.getHTMLElement().style.height = `${height}px`;
			list.splice(0, list.length, entries);
		}));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	override focus(): void {
		super.focus();
		this.listRef?.object.domFocus();
	}

	override dispose(): void {
		this.listRef?.dispose();
		this.listRef = undefined;
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
