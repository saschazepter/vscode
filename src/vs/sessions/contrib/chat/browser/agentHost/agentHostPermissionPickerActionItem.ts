/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, IReader, observableSignal } from '../../../../../base/common/observable.js';
import { MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { ISessionConfigPropertySchema } from '../../../../../platform/agentHost/common/state/protocol/commands.js';
import { ChatPermissionLevel, isChatPermissionLevel } from '../../../../../workbench/contrib/chat/common/constants.js';
import { IChatInputPickerOptions } from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputPickerActionItem.js';
import {
	IPermissionPickerDelegate,
	PermissionPickerActionItem,
} from '../../../../../workbench/contrib/chat/browser/widget/input/permissionPickerActionItem.js';
import { IAgentHostSessionsProvider, isAgentHostProvider } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';

/**
 * The well-known session-config property name for tool auto-approval. The
 * Agent Host Protocol's session-config schema is intentionally generic — only
 * this property *name* (and the enum values below) is a convention shared
 * across implementations that want to opt into VS Code's unified
 * permission-picker UI. Agents that don't advertise this exact shape fall
 * back to the generic per-property picker.
 */
export const AUTO_APPROVE_SESSION_CONFIG_PROPERTY = 'autoApprove';

/**
 * The set of enum values the workbench permission picker
 * (`PermissionPickerActionItem`) understands for the `autoApprove` property.
 * Mirrors `ChatPermissionLevel` in `vs/workbench/contrib/chat/common/constants.ts`.
 *
 * `autopilot` is optional (an agent may choose not to advertise it). `default`
 * is required as the baseline level.
 */
const KNOWN_AUTO_APPROVE_VALUES: ReadonlySet<string> = new Set(['default', 'autoApprove', 'autopilot']);
const REQUIRED_AUTO_APPROVE_VALUE = 'default';

/**
 * Returns `true` when an `autoApprove` session-config property uses the
 * shape the workbench `PermissionPickerActionItem` widget expects:
 * a string enum that is a subset of `default | autoApprove | autopilot` and
 * contains at least `default`.
 *
 * Callers use this to decide whether to render the unified workbench picker
 * (with its built-in warning dialogs, autopilot gating, and policy
 * enforcement) or fall back to the generic per-property picker.
 */
export function isWellKnownAutoApproveSchema(schema: ISessionConfigPropertySchema): boolean {
	if (schema.type !== 'string' || !Array.isArray(schema.enum) || schema.enum.length === 0) {
		return false;
	}
	if (!schema.enum.includes(REQUIRED_AUTO_APPROVE_VALUE)) {
		return false;
	}
	return schema.enum.every(value => KNOWN_AUTO_APPROVE_VALUES.has(value));
}

/**
 * Implements {@link IPermissionPickerDelegate} backed by the active session's
 * AHP `autoApprove` config property.
 *
 * - `currentPermissionLevel` derives from the active session's
 *   `provider.getSessionConfig(...).values.autoApprove`, recomputed when the
 *   active session changes or when any agent-host provider fires
 *   `onDidChangeSessionConfig`.
 * - `setPermissionLevel(level)` calls `provider.setSessionConfigValue(sessionId,
 *   'autoApprove', level)` for the active session's provider.
 * - `isWellKnownActiveSession` exposes whether the active session's `autoApprove`
 *   schema matches the workbench picker's expected shape, so the action view
 *   item can hide itself when it doesn't.
 */
export class AgentHostPermissionPickerDelegate extends Disposable implements IPermissionPickerDelegate {

	/** Fires every time any agent-host provider's session config changes. */
	private readonly _configChangedSignal = observableSignal('agentHostPermissionPicker.configChanged');
	private readonly _providerSubscriptions = this._register(new DisposableMap<string>());

	readonly currentPermissionLevel: IObservable<ChatPermissionLevel>;
	readonly isWellKnownActiveSession: IObservable<boolean>;

	constructor(
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
	) {
		super();

		this._watchProviders(this._sessionsProvidersService.getProviders());
		this._register(this._sessionsProvidersService.onDidChangeProviders(e => {
			for (const provider of e.removed) {
				this._providerSubscriptions.deleteAndDispose(provider.id);
			}
			this._watchProviders(e.added);
			this._configChangedSignal.trigger(undefined);
		}));

		this.currentPermissionLevel = derived(this, reader => this._readLevel(reader));
		this.isWellKnownActiveSession = derived(this, reader => this._readIsWellKnown(reader));
	}

	setPermissionLevel(level: ChatPermissionLevel): void {
		const provider = this._activeProvider();
		const session = this._sessionsManagementService.activeSession.get();
		if (!provider || !session) {
			return;
		}
		provider.setSessionConfigValue(session.sessionId, AUTO_APPROVE_SESSION_CONFIG_PROPERTY, level)
			.catch(() => { /* best-effort */ });
	}

	private _readLevel(reader: IReader): ChatPermissionLevel {
		this._configChangedSignal.read(reader);
		const session = this._sessionsManagementService.activeSession.read(reader);
		if (!session) {
			return ChatPermissionLevel.Default;
		}
		const provider = this._getProvider(session.providerId);
		if (!provider) {
			return ChatPermissionLevel.Default;
		}
		const value = provider.getSessionConfig(session.sessionId)?.values[AUTO_APPROVE_SESSION_CONFIG_PROPERTY];
		return isChatPermissionLevel(value) ? value : ChatPermissionLevel.Default;
	}

	private _readIsWellKnown(reader: IReader): boolean {
		this._configChangedSignal.read(reader);
		const session = this._sessionsManagementService.activeSession.read(reader);
		if (!session) {
			return false;
		}
		const provider = this._getProvider(session.providerId);
		if (!provider) {
			return false;
		}
		const schema = provider.getSessionConfig(session.sessionId)?.schema.properties[AUTO_APPROVE_SESSION_CONFIG_PROPERTY];
		return !!schema && isWellKnownAutoApproveSchema(schema);
	}

	private _activeProvider(): IAgentHostSessionsProvider | undefined {
		const session = this._sessionsManagementService.activeSession.get();
		return session ? this._getProvider(session.providerId) : undefined;
	}

	private _getProvider(providerId: string): IAgentHostSessionsProvider | undefined {
		const provider = this._sessionsProvidersService.getProvider(providerId);
		return provider && isAgentHostProvider(provider) ? provider : undefined;
	}

	private _watchProviders(providers: readonly ISessionsProvider[]): void {
		for (const provider of providers) {
			if (!isAgentHostProvider(provider) || this._providerSubscriptions.has(provider.id)) {
				continue;
			}
			this._providerSubscriptions.set(provider.id, provider.onDidChangeSessionConfig(() => {
				this._configChangedSignal.trigger(undefined);
			}));
		}
	}
}

/**
 * The Agents-window action view item for the auto-approve picker, reusing the
 * workbench {@link PermissionPickerActionItem} so the dropdown UX, warning
 * dialogs, autopilot gating, and policy enforcement are shared with the chat
 * input version.
 *
 * Owns its {@link AgentHostPermissionPickerDelegate} (the picker is the only
 * consumer) and refreshes the trigger label whenever the delegate's level
 * observable ticks (the base widget's label render is pull-based).
 */
export class AgentHostPermissionPickerActionItem extends PermissionPickerActionItem {

	private readonly _delegate: AgentHostPermissionPickerDelegate;

	constructor(
		action: MenuItemAction,
		pickerOptions: IChatInputPickerOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IConfigurationService configurationService: IConfigurationService,
		@IDialogService dialogService: IDialogService,
		@IOpenerService openerService: IOpenerService,
	) {
		const delegate = instantiationService.createInstance(AgentHostPermissionPickerDelegate);
		super(
			action,
			delegate,
			pickerOptions,
			actionWidgetService,
			keybindingService,
			contextKeyService,
			telemetryService,
			configurationService,
			dialogService,
			openerService,
		);

		this._delegate = this._register(delegate);

		// The base widget renders its label on demand via `refresh()`.
		// Keep it in sync with the delegate's level observable.
		this._register(autorun(reader => {
			delegate.currentPermissionLevel.read(reader);
			this.refresh();
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('sessions-agent-host-permission-picker');

		// Reactively show/hide ourselves based on whether the *current* active
		// session's `autoApprove` schema matches the workbench widget's
		// expectations. The active session can change while this view item is
		// alive (e.g. user navigates back to the new-chat view), so we can't
		// gate this at construction time.
		this._register(autorun(reader => {
			const wellKnown = this._delegate.isWellKnownActiveSession.read(reader);
			if (this.element) {
				this.element.style.display = wellKnown ? '' : 'none';
			}
		}));
	}
}
