/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/hostBarPart.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { Action } from '../../../base/common/actions.js';
import { Codicon } from '../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { autorun } from '../../../base/common/observable.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { localize } from '../../../nls.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { contrastBorder } from '../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { Part } from '../../../workbench/browser/part.js';
import { ACTIVITY_BAR_BACKGROUND, ACTIVITY_BAR_BORDER } from '../../../workbench/common/theme.js';
import { IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';
import { IRemoteAgentHostService, RemoteAgentHostConnectionStatus } from '../../../platform/agentHost/common/remoteAgentHostService.js';
import { ITunnelAgentHostService, TUNNEL_ADDRESS_PREFIX } from '../../../platform/agentHost/common/tunnelAgentHost.js';
import { IAgentHostSessionsProvider, isAgentHostProvider } from '../../common/agentHostSessionsProvider.js';
import { HostBarVisibleContext } from '../../common/contextkeys.js';
import { ISessionsProvidersService } from '../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsProvider } from '../../services/sessions/common/sessionsProvider.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { AgenticParts } from './parts.js';

/** Command id contributed by remote agent host actions; opens the add-host flow. */
const ADD_REMOTE_AGENT_HOST_COMMAND_ID = 'sessions.remoteAgentHost.add';

const HOVER_GROUP_ID = 'hostbar';

/**
 * A slim left-edge rail that lists registered session providers as avatar badges
 * with a connection-status dot. Selecting an entry sets the active sessions
 * provider. An "+" button at the bottom dispatches the "Add Remote Agent Host"
 * command.
 *
 * Only instantiated and wired into the grid in web builds with remote agent
 * hosts enabled — see {@link Workbench.createWorkbenchLayout}.
 */
export class HostBarPart extends Part {

	//#region IView

	readonly minimumWidth: number = 48;
	readonly maximumWidth: number = 48;
	readonly minimumHeight: number = 0;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	//#endregion

	private content: HTMLElement | undefined;
	private actionsContainer: HTMLElement | undefined;
	private footerContainer: HTMLElement | undefined;
	private readonly entryDisposables = this._register(new MutableDisposable<DisposableStore>());
	/** Rail tile elements in render order; kept in sync by {@link renderContent}. */
	private entryElements: HTMLElement[] = [];

	private readonly hostBarVisibleContextKey: IContextKey<boolean>;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@IHoverService private readonly hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IDialogService private readonly dialogService: IDialogService,
		@ITunnelAgentHostService private readonly tunnelAgentHostService: ITunnelAgentHostService,
		@IRemoteAgentHostService private readonly remoteAgentHostService: IRemoteAgentHostService,
	) {
		super(AgenticParts.HOSTBAR_PART, { hasTitle: false }, themeService, storageService, layoutService);

		this.hostBarVisibleContextKey = HostBarVisibleContext.bindTo(contextKeyService);
		this.hostBarVisibleContextKey.set(true);

		// Re-render when the set of providers changes or the active provider changes.
		this._register(this.sessionsProvidersService.onDidChangeProviders(() => {
			this.ensureRemoteProviderActive();
			this.renderContent();
		}));
		this._register(autorun(reader => {
			this.sessionsManagementService.activeProviderId.read(reader);
			this.renderContent();
		}));

		// When the rail is present, everything is remote. The shared sessions
		// management service defaults to the first registered provider (the
		// local Copilot Chat), which would leave the user looking at an
		// empty, disconnected sessions list. Promote to a connected remote
		// host as soon as one becomes available.
		this.ensureRemoteProviderActive();
		this._register(autorun(reader => {
			// Re-run whenever a remote provider's connection status flips.
			for (const provider of this.sessionsProvidersService.getProviders()) {
				if (isAgentHostProvider(provider) && provider.connectionStatus) {
					provider.connectionStatus.read(reader);
				}
			}
			this.ensureRemoteProviderActive();
		}));
	}

	/**
	 * If the current active provider has no `remoteAddress` (i.e. it is the
	 * local Copilot Chat fallback), prefer a remote host instead — first a
	 * connected one, otherwise the first registered remote provider.
	 * Only promotes; never demotes. Selecting Copilot Chat is not possible
	 * from the rail itself once the local tile is hidden, so the user can
	 * only leave this state by explicitly picking a remote tile.
	 */
	private ensureRemoteProviderActive(): void {
		const providers = this.sessionsProvidersService.getProviders();
		const remoteProviders = providers.filter(p => {
			const host = isAgentHostProvider(p) ? p : undefined;
			return !!host?.remoteAddress;
		});
		if (remoteProviders.length === 0) {
			return;
		}
		const activeId = this.sessionsManagementService.activeProviderId.get();
		const active = activeId ? providers.find(p => p.id === activeId) : undefined;
		const activeIsRemote = active && isAgentHostProvider(active) && !!active.remoteAddress;
		if (activeIsRemote) {
			return;
		}
		const connected = remoteProviders.find(p => {
			const host = isAgentHostProvider(p) ? p : undefined;
			return host?.connectionStatus?.get() === RemoteAgentHostConnectionStatus.Connected;
		});
		const next = connected ?? remoteProviders[0];
		this.sessionsManagementService.setActiveProvider(next.id);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this.content = append(this.element, $('.content'));

		this.actionsContainer = append(this.content, $('.actions-container'));
		this.actionsContainer.setAttribute('role', 'tablist');
		this.actionsContainer.setAttribute('aria-orientation', 'vertical');
		this.actionsContainer.setAttribute('aria-label', localize('hostBar.label', "Agent Hosts"));
		this.footerContainer = append(this.content, $('.footer-container'));

		this.renderContent();

		return this.content;
	}

	private renderContent(): void {
		if (!this.actionsContainer || !this.footerContainer) {
			return;
		}

		clearNode(this.actionsContainer);
		clearNode(this.footerContainer);
		this.entryDisposables.value = new DisposableStore();
		this.entryElements = [];

		const providers = this.sessionsProvidersService.getProviders();
		const activeId = this.sessionsManagementService.activeProviderId.get();

		// Only show remote agent host providers in the rail. On
		// vscode.dev/agents everything is remote, so the local Copilot Chat
		// provider (which has no `remoteAddress`) is intentionally hidden.
		const remoteProviders = providers.filter(p => {
			const host = isAgentHostProvider(p) ? p : undefined;
			return !!host?.remoteAddress;
		});

		// Final-pass consolidation: if two registered providers end up with
		// the same normalized label (e.g. stale cache entries that survived
		// the service-level dedup because one of them had no `name`), we
		// collapse them to a single rail tile. We prefer the currently
		// active provider, then a provider that is connected, then the
		// first one we saw.
		const dedupedProviders = this.consolidateProvidersByLabel(remoteProviders, activeId);

		for (const provider of dedupedProviders) {
			this.createProviderEntry(this.actionsContainer, provider, activeId === provider.id);
		}

		this.createAddHostButton(this.footerContainer);
	}

	/**
	 * Collapse providers that share the same normalized label into a single
	 * tile. This is a UI-level safety net for stale cached tunnels that
	 * escaped the service-level dedup. When a group has more than one
	 * provider, we pick the one most likely to be useful: active > connected
	 * > first registered.
	 */
	private consolidateProvidersByLabel(
		providers: readonly ISessionsProvider[],
		activeId: string | undefined,
	): ISessionsProvider[] {
		const groups = new Map<string, ISessionsProvider[]>();
		const order: string[] = [];
		for (const provider of providers) {
			const key = provider.label?.trim().toLowerCase() || `__id:${provider.id}`;
			let bucket = groups.get(key);
			if (!bucket) {
				bucket = [];
				groups.set(key, bucket);
				order.push(key);
			}
			bucket.push(provider);
		}
		return order.map(key => {
			const bucket = groups.get(key)!;
			if (bucket.length === 1) {
				return bucket[0];
			}
			const active = bucket.find(p => p.id === activeId);
			if (active) {
				return active;
			}
			const connected = bucket.find(p => {
				const host = isAgentHostProvider(p) ? p : undefined;
				return host?.connectionStatus?.get() === RemoteAgentHostConnectionStatus.Connected;
			});
			return connected ?? bucket[0];
		});
	}

	private createProviderEntry(container: HTMLElement, provider: ISessionsProvider, isSelected: boolean): void {
		const entryDisposables = this.entryDisposables.value!;

		const entryElement = append(container, $('.action-item.host-entry'));
		this.entryElements.push(entryElement);
		append(entryElement, $('span.active-item-indicator'));

		const badge = append(entryElement, $('span.host-badge'));

		// Icon reflects online/offline state:
		//   vm-active  → connected (or provider without a connection observable, e.g. local/Copilot)
		//   vm-outline → disconnected / connecting
		const agentHost = isAgentHostProvider(provider) ? provider : undefined;
		const icon = append(badge, $('span.host-icon'));
		this.applyStateIcon(icon, agentHost);
		if (agentHost?.connectionStatus) {
			entryDisposables.add(autorun(reader => {
				agentHost.connectionStatus!.read(reader);
				this.applyStateIcon(icon, agentHost);
			}));
		}

		if (isSelected) {
			entryElement.classList.add('checked');
		}

		// Hover.
		entryDisposables.add(this.hoverService.setupDelayedHover(
			entryElement,
			{
				appearance: { showPointer: true },
				position: { hoverPosition: HoverPosition.RIGHT },
				content: this.getHoverContent(provider, agentHost)
			},
			{ groupId: HOVER_GROUP_ID }
		));

		// Click + keyboard.
		const select = () => this.sessionsManagementService.setActiveProvider(provider.id);
		entryDisposables.add(addDisposableListener(entryElement, EventType.CLICK, select));

		entryElement.setAttribute('tabindex', isSelected ? '0' : '-1');
		entryElement.setAttribute('role', 'tab');
		entryElement.setAttribute('aria-label', provider.label);
		entryElement.setAttribute('aria-selected', isSelected ? 'true' : 'false');
		entryDisposables.add(addDisposableListener(entryElement, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				select();
				return;
			}
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
				e.preventDefault();
				this.moveFocus(entryElement, e.key);
			}
		}));

		// Context menu: allow removing remote hosts from the rail.
		entryDisposables.add(addDisposableListener(entryElement, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			this.showEntryContextMenu(entryElement, provider, agentHost, e);
		}));
	}

	private showEntryContextMenu(
		anchorElement: HTMLElement,
		provider: ISessionsProvider,
		agentHost: IAgentHostSessionsProvider | undefined,
		e: MouseEvent,
	): void {
		// Only remote agent host providers (with an address) can be removed.
		// The local Copilot Chat provider has no `remoteAddress`.
		const address = agentHost?.remoteAddress;
		if (!address) {
			return;
		}
		const event = new StandardMouseEvent(getWindow(anchorElement), e);
		this.contextMenuService.showContextMenu({
			getAnchor: () => event,
			getActions: () => [
				new Action(
					'hostBar.removeHost',
					localize('hostBar.removeHost', "Remove Host"),
					undefined,
					true,
					() => this.removeHost(provider, address),
				),
			],
		});
	}

	private async removeHost(provider: ISessionsProvider, address: string): Promise<void> {
		const confirmed = await this.dialogService.confirm({
			type: 'warning',
			message: localize('hostBar.removeHost.confirm', "Remove '{0}' from the host list?", provider.label),
			detail: localize('hostBar.removeHost.detail', "This disconnects the host and removes it from your list. You can add it again later."),
			primaryButton: localize('hostBar.removeHost.button', "Remove"),
		});
		if (!confirmed.confirmed) {
			return;
		}

		// If the host we're removing is currently active, fall back to the
		// first remaining provider (typically local Copilot Chat) so the
		// sessions list doesn't end up filtering on a stale provider id.
		const activeId = this.sessionsManagementService.activeProviderId.get();
		if (activeId === provider.id) {
			const fallback = this.sessionsProvidersService.getProviders().find(p => p.id !== provider.id);
			if (fallback) {
				this.sessionsManagementService.setActiveProvider(fallback.id);
			}
		}

		// Disconnect any live relay connection (best effort). For tunnels,
		// `removeCachedTunnel` drops the cache entry so reconcile prunes the
		// provider. For non-tunnel remotes, `removeRemoteAgentHost` both
		// disconnects and removes the configured entry.
		try {
			if (address.startsWith(TUNNEL_ADDRESS_PREFIX)) {
				const tunnelId = address.slice(TUNNEL_ADDRESS_PREFIX.length);
				try {
					await this.tunnelAgentHostService.disconnect(address);
				} catch {
					// Not connected — ignore.
				}
				// Drop every cache entry for this tunnel. Older sessions may
				// have accumulated multiple entries with the same `name` but
				// different tunnelIds (one per `code tunnel` restart); if we
				// only removed the tunnelId we right-clicked, reconcile would
				// just surface the next duplicate and the tile would appear
				// to come back. We key off the provider label (== tunnel name)
				// plus the cached tunnels list so the removal sticks.
				const nameKey = provider.label?.trim().toLowerCase();
				const siblingIds = nameKey
					? this.tunnelAgentHostService.getCachedTunnels()
						.filter(t => t.name?.trim().toLowerCase() === nameKey)
						.map(t => t.tunnelId)
					: [];
				const toRemove = new Set<string>([tunnelId, ...siblingIds]);
				for (const id of toRemove) {
					this.tunnelAgentHostService.removeCachedTunnel(id);
				}
			} else {
				await this.remoteAgentHostService.removeRemoteAgentHost(address);
			}
		} catch (err) {
			this.dialogService.error(
				localize('hostBar.removeHost.failed', "Failed to remove host '{0}'.", provider.label),
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	private moveFocus(current: HTMLElement, key: string): void {
		const entries = this.entryElements;
		if (entries.length === 0) {
			return;
		}
		const idx = entries.indexOf(current);
		if (idx === -1) {
			return;
		}
		let next: number;
		switch (key) {
			case 'ArrowDown':
				next = (idx + 1) % entries.length;
				break;
			case 'ArrowUp':
				next = (idx - 1 + entries.length) % entries.length;
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = entries.length - 1;
				break;
			default:
				return;
		}
		entries[next].focus();
	}

	private applyStateIcon(icon: HTMLElement, agentHost: IAgentHostSessionsProvider | undefined): void {
		const status = agentHost?.connectionStatus?.get();
		// Providers without a connection observable are always reachable (local, Copilot).
		const connected = status === undefined || status === RemoteAgentHostConnectionStatus.Connected;
		const themeIcon = connected ? Codicon.vmActive : Codicon.vmOutline;
		icon.className = 'host-icon';
		icon.classList.add(...ThemeIcon.asClassNameArray(themeIcon));
		icon.classList.toggle('connected', connected);
		icon.classList.toggle('connecting', status === RemoteAgentHostConnectionStatus.Connecting);
		icon.classList.toggle('disconnected', status === RemoteAgentHostConnectionStatus.Disconnected);
	}

	private getHoverContent(provider: ISessionsProvider, agentHost: IAgentHostSessionsProvider | undefined): string {
		const status = agentHost?.connectionStatus?.get();
		let suffix: string | undefined;
		switch (status) {
			case RemoteAgentHostConnectionStatus.Connected:
				suffix = localize('hostBar.connected', "Connected");
				break;
			case RemoteAgentHostConnectionStatus.Connecting:
				suffix = localize('hostBar.connecting', "Connecting");
				break;
			case RemoteAgentHostConnectionStatus.Disconnected:
				suffix = localize('hostBar.disconnected', "Disconnected");
				break;
		}
		return suffix ? `${provider.label} — ${suffix}` : provider.label;
	}

	private createAddHostButton(container: HTMLElement): void {
		const button = append(container, $('.action-item.add-host'));
		const actionLabel = append(button, $('span.action-label'));
		actionLabel.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));

		const addLabel = localize('hostBar.addHost', "Add Remote Agent Host");
		this.entryDisposables.value!.add(this.hoverService.setupDelayedHover(
			button,
			{
				appearance: { showPointer: true },
				position: { hoverPosition: HoverPosition.RIGHT },
				content: addLabel
			},
			{ groupId: HOVER_GROUP_ID }
		));

		const run = () => this.commandService.executeCommand(ADD_REMOTE_AGENT_HOST_COMMAND_ID);
		this.entryDisposables.value!.add(addDisposableListener(button, EventType.CLICK, run));

		button.setAttribute('tabindex', '0');
		button.setAttribute('role', 'button');
		button.setAttribute('aria-label', addLabel);
		this.entryDisposables.value!.add(addDisposableListener(button, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				run();
			}
		}));
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());
		const background = this.getColor(ACTIVITY_BAR_BACKGROUND) || '';
		container.style.backgroundColor = background;

		const borderColor = this.getColor(ACTIVITY_BAR_BORDER) || this.getColor(contrastBorder) || '';
		container.classList.toggle('bordered', !!borderColor);
		container.style.borderColor = borderColor || '';
	}

	override layout(width: number, height: number): void {
		super.layout(width, height, 0, 0);
	}

	toJSON(): object {
		return {
			type: AgenticParts.HOSTBAR_PART
		};
	}
}
