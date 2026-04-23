/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuRegistry, registerAction2, SubmenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IActionWidgetDropdownAction } from '../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IRemoteAgentHostService } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsAuxiliaryWindowContext } from '../../../../workbench/common/contextkeys.js';
import { Menus } from '../../../browser/menus.js';
import { logSessionsInteraction } from '../../../common/sessionsTelemetry.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { OpenInActionViewItem } from '../browser/openInActionViewItem.js';
import { VSCODE_STABLE_ICON_URI, VSCODE_INSIDERS_ICON_URI } from '../browser/openInIcons.js';
import { canOpenInVSCode, canUseLocalPath, createVSCodeOpenUri, OpenInDropdownMenuId, OPEN_IN_TARGET_STORAGE_KEY, OpenInTarget, readStoredOpenInTarget, resolveOpenInTarget } from '../browser/openInVSCodeUtils.js';

const OPEN_IN_SPLIT_BUTTON_ORDER = 7;
const OPEN_IN_VSCODE_STABLE_ACTION_ID = 'workbench.action.agentSessions.openIn.vscodeStable';
const OPEN_IN_VSCODE_INSIDERS_ACTION_ID = 'workbench.action.agentSessions.openIn.vscodeInsiders';
const OPEN_IN_FINDER_ACTION_ID = 'workbench.action.agentSessions.openIn.finder';
const OPEN_IN_COPY_PATH_ACTION_ID = 'workbench.action.agentSessions.openIn.copyPath';
const VSCODE_STABLE_APPLICATION_NAME = 'Visual Studio Code';
const VSCODE_INSIDERS_APPLICATION_NAME = 'Visual Studio Code - Insiders';

export class OpenInContribution extends Disposable {

	static readonly ID = 'workbench.contrib.agentSessions.openIn';

	private _selectedTarget: OpenInTarget;

	constructor(
		@IActionViewItemService private readonly actionViewItemService: IActionViewItemService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@IRemoteAgentHostService private readonly remoteAgentHostService: IRemoteAgentHostService,
		@IStorageService private readonly storageService: IStorageService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();
		this._selectedTarget = readStoredOpenInTarget(storageService);

		this._register(this.actionViewItemService.register(
			Menus.TitleBarSessionMenu,
			OpenInDropdownMenuId,
			(action, options, instantiationService) => {
				if (!(action instanceof SubmenuItemAction)) {
					return undefined;
				}

				return instantiationService.createInstance(
					OpenInActionViewItem,
					action,
					options,
					() => this._runTarget(this._selectedTarget, 'primary'),
					() => this._getDropdownActions(),
				);
			},
		));
	}

	private _getDropdownActions(): IActionWidgetDropdownAction[] {
		const openTarget = resolveOpenInTarget(
			this.sessionsManagementService,
			this.sessionsProvidersService,
			this.remoteAgentHostService,
			this.storageService,
		);
		const canOpenVSCode = canOpenInVSCode(openTarget);
		const canUsePath = canUseLocalPath(openTarget);
		const destinationsCategory = { label: 'destinations', order: 0, showHeader: false };
		const copyCategory = { label: 'copy', order: 1, showHeader: false };

		return [
			{
				id: OpenInTarget.VSCodeStable,
				label: localize('vscodeStable', "VS Code Stable"),
				tooltip: '',
				icon: Codicon.vscode,
				iconUrl: VSCODE_STABLE_ICON_URI,
				enabled: canOpenVSCode,
				class: undefined,
				category: destinationsCategory,
				run: async () => this._runAndPersistTarget(OpenInTarget.VSCodeStable, 'menu'),
			},
			{
				id: OpenInTarget.VSCodeInsiders,
				label: localize('vscodeInsiders', "VS Code Insiders"),
				tooltip: '',
				icon: Codicon.vscodeInsiders,
				iconUrl: VSCODE_INSIDERS_ICON_URI,
				enabled: canOpenVSCode,
				class: undefined,
				category: destinationsCategory,
				run: async () => this._runAndPersistTarget(OpenInTarget.VSCodeInsiders, 'menu'),
			},
			{
				id: OpenInTarget.Finder,
				label: localize('finder', "Finder"),
				tooltip: '',
				icon: Codicon.folderOpened,
				enabled: canUsePath,
				class: undefined,
				category: destinationsCategory,
				run: async () => this._runAndPersistTarget(OpenInTarget.Finder, 'menu'),
			},
			{
				id: OpenInTarget.CopyPath,
				label: localize('copyPath', "Copy Path"),
				tooltip: '',
				icon: Codicon.copy,
				enabled: canUsePath,
				class: undefined,
				category: copyCategory,
				run: async () => this._runAndPersistTarget(OpenInTarget.CopyPath, 'menu'),
			},
		];
	}

	private async _runAndPersistTarget(target: OpenInTarget, source: 'primary' | 'menu'): Promise<void> {
		this._selectedTarget = target;
		this.storageService.store(OPEN_IN_TARGET_STORAGE_KEY, target, StorageScope.PROFILE, StorageTarget.MACHINE);
		await this._runTarget(target, source);
	}

	private async _runTarget(target: OpenInTarget, source: 'primary' | 'menu'): Promise<void> {
		const openTarget = resolveOpenInTarget(
			this.sessionsManagementService,
			this.sessionsProvidersService,
			this.remoteAgentHostService,
			this.storageService,
		);
		if (!openTarget) {
			this.notificationService.info(localize('selectWorkspaceFirst', "Select a workspace first."));
			return;
		}

		switch (target) {
			case OpenInTarget.VSCodeStable:
			case OpenInTarget.VSCodeInsiders: {
				if (!canOpenInVSCode(openTarget)) {
					this.notificationService.info(localize('openInVSCodeUnsupported', "Only local folders and SSH or tunnel workspaces can be opened in VS Code from here."));
					return;
				}

				const isStable = target === OpenInTarget.VSCodeStable;
				this.notificationService.info(isStable
					? localize('openingInVSCodeStable', "Opening in VS Code Stable...")
					: localize('openingInVSCodeInsiders', "Opening in VS Code Insiders..."));
				logSessionsInteraction(this.telemetryService, target === OpenInTarget.VSCodeStable ? 'openInVSCodeStable' : 'openInVSCodeInsiders');
				await openVSCodeTarget(this.nativeHostService, target, openTarget, source);
				return;
			}
			case OpenInTarget.Finder:
				if (!canUseLocalPath(openTarget)) {
					this.notificationService.info(localize('finderUnsupported', "Finder is only available for local folders."));
					return;
				}

				this.notificationService.info(localize('openingInFinder', "Opening in Finder..."));
				logSessionsInteraction(this.telemetryService, 'openInFinder');
				await this.nativeHostService.showItemInFolder(openTarget.filePath);
				return;
			case OpenInTarget.CopyPath:
				if (!canUseLocalPath(openTarget)) {
					this.notificationService.info(localize('copyPathUnsupported', "Copy Path is only available for local folders."));
					return;
				}

				logSessionsInteraction(this.telemetryService, 'copyPath');
				await this.clipboardService.writeText(openTarget.filePath);
				this.notificationService.info(localize('copiedPath', "Copied path to clipboard."));
				return;
		}
	}
}

async function runOpenInTarget(accessor: ServicesAccessor, target: OpenInTarget): Promise<void> {
	const sessionsManagementService = accessor.get(ISessionsManagementService);
	const sessionsProvidersService = accessor.get(ISessionsProvidersService);
	const remoteAgentHostService = accessor.get(IRemoteAgentHostService);
	const storageService = accessor.get(IStorageService);
	const nativeHostService = accessor.get(INativeHostService);
	const clipboardService = accessor.get(IClipboardService);
	const notificationService = accessor.get(INotificationService);
	const telemetryService = accessor.get(ITelemetryService);

	storageService.store(OPEN_IN_TARGET_STORAGE_KEY, target, StorageScope.PROFILE, StorageTarget.MACHINE);

	const openTarget = resolveOpenInTarget(
		sessionsManagementService,
		sessionsProvidersService,
		remoteAgentHostService,
		storageService,
	);
	if (!openTarget) {
		notificationService.info(localize('selectWorkspaceFirst', "Select a workspace first."));
		return;
	}

	switch (target) {
		case OpenInTarget.VSCodeStable:
		case OpenInTarget.VSCodeInsiders: {
			if (!canOpenInVSCode(openTarget)) {
				notificationService.info(localize('openInVSCodeUnsupported', "Only local folders and SSH or tunnel workspaces can be opened in VS Code from here."));
				return;
			}

			const isStable = target === OpenInTarget.VSCodeStable;
			notificationService.info(isStable
				? localize('openingInVSCodeStable', "Opening in VS Code Stable...")
				: localize('openingInVSCodeInsiders', "Opening in VS Code Insiders..."));
			logSessionsInteraction(telemetryService, target === OpenInTarget.VSCodeStable ? 'openInVSCodeStable' : 'openInVSCodeInsiders');
			await openVSCodeTarget(nativeHostService, target, openTarget, 'menu');
			return;
		}
		case OpenInTarget.Finder:
			if (!canUseLocalPath(openTarget)) {
				notificationService.info(localize('finderUnsupported', "Finder is only available for local folders."));
				return;
			}

			notificationService.info(localize('openingInFinder', "Opening in Finder..."));
			logSessionsInteraction(telemetryService, 'openInFinder');
			await nativeHostService.showItemInFolder(openTarget.filePath);
			return;
		case OpenInTarget.CopyPath:
			if (!canUseLocalPath(openTarget)) {
				notificationService.info(localize('copyPathUnsupported', "Copy Path is only available for local folders."));
				return;
			}

			logSessionsInteraction(telemetryService, 'copyPath');
			await clipboardService.writeText(openTarget.filePath);
			notificationService.info(localize('copiedPath', "Copied path to clipboard."));
			return;
	}
}

async function openVSCodeTarget(
	nativeHostService: INativeHostService,
	target: OpenInTarget,
	openTarget: NonNullable<ReturnType<typeof resolveOpenInTarget>>,
	source: 'primary' | 'menu',
): Promise<void> {
	const folderUri = openTarget.remoteAuthority
		? URI.from({ scheme: Schemas.vscodeRemote, authority: openTarget.remoteAuthority, path: openTarget.folderUri.path })
		: openTarget.folderUri;
	const isStable = target === OpenInTarget.VSCodeStable;
	const defaultApplication = isMacintosh
		? (isStable ? VSCODE_STABLE_APPLICATION_NAME : VSCODE_INSIDERS_APPLICATION_NAME)
		: undefined;
	const targetUri = isMacintosh && !openTarget.remoteAuthority
		? folderUri
		: createVSCodeOpenUri(target as OpenInTarget.VSCodeStable | OpenInTarget.VSCodeInsiders, openTarget);

	console.log('[SessionsOpenIn/electron] openVSCodeTarget', {
		target,
		source,
		defaultApplication,
		targetUri: targetUri?.toString(),
		folderUri: folderUri.toString(),
		remoteAuthority: openTarget.remoteAuthority,
		sessionResource: openTarget.sessionResource?.toString(),
	});

	if (!targetUri) {
		throw new Error(`Unable to resolve VS Code open target for ${target}`);
	}

	if (!isMacintosh && target === OpenInTarget.VSCodeInsiders) {
		console.log('[SessionsOpenIn/electron] launchSiblingApp', {
			target,
			source,
			args: ['--new-window', '--folder-uri', folderUri.toString()],
		});
		await nativeHostService.launchSiblingApp(['--new-window', '--folder-uri', folderUri.toString()]);
		return;
	}

	await nativeHostService.openExternal(targetUri.toString(), defaultApplication);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_IN_VSCODE_STABLE_ACTION_ID,
			title: localize2('vscodeStable', "VS Code Stable"),
			icon: Codicon.vscode,
			menu: [{
				id: OpenInDropdownMenuId,
				group: 'navigation',
				order: 1,
			}]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runOpenInTarget(accessor, OpenInTarget.VSCodeStable);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_IN_VSCODE_INSIDERS_ACTION_ID,
			title: localize2('vscodeInsiders', "VS Code Insiders"),
			icon: Codicon.vscodeInsiders,
			menu: [{
				id: OpenInDropdownMenuId,
				group: 'navigation',
				order: 2,
			}]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runOpenInTarget(accessor, OpenInTarget.VSCodeInsiders);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_IN_FINDER_ACTION_ID,
			title: localize2('finder', "Finder"),
			icon: Codicon.folderOpened,
			menu: [{
				id: OpenInDropdownMenuId,
				group: 'navigation',
				order: 3,
			}]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runOpenInTarget(accessor, OpenInTarget.Finder);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_IN_COPY_PATH_ACTION_ID,
			title: localize2('copyPath', "Copy Path"),
			icon: Codicon.copy,
			menu: [{
				id: OpenInDropdownMenuId,
				group: '2_clipboard',
				order: 4,
			}]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runOpenInTarget(accessor, OpenInTarget.CopyPath);
	}
});

MenuRegistry.appendMenuItem(Menus.TitleBarSessionMenu, {
	submenu: OpenInDropdownMenuId,
	isSplitButton: true,
	title: localize2('openIn', "Open In"),
	icon: Codicon.vscodeInsiders,
	group: 'navigation',
	order: OPEN_IN_SPLIT_BUTTON_ORDER,
	when: IsAuxiliaryWindowContext.toNegated(),
});

registerWorkbenchContribution2(OpenInContribution.ID, OpenInContribution, WorkbenchPhase.AfterRestored);
