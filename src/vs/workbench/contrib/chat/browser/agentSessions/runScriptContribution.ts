/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { isEqualOrParent } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { MenuId, registerAction2, Action2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IAgentWorkbenchWorkspaceService } from '../../../../services/agentSessions/browser/agentWorkbenchWorkspaceService.js';
import { IDebugService, ILaunch } from '../../../debug/common/debug.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';

// Storage keys
const STORAGE_KEY_DEFAULT_RUN_ACTION = 'workbench.agentSessions.defaultRunAction';

// Menu IDs - exported for use in auxiliary bar part
export const RunScriptDropdownMenuId = MenuId.for('AgentSessionsRunScriptDropdown');

// Action IDs
const RUN_SCRIPT_ACTION_ID = 'workbench.action.agentSessions.runScript';
const CONFIGURE_DEFAULT_RUN_ACTION_ID = 'workbench.action.agentSessions.configureDefaultRunAction';
const RUN_DEBUG_CONFIGURATION_PREFIX = 'workbench.action.agentSessions.runDebugConfiguration.';

// Types for stored default action
interface IStoredRunAction {
	readonly type: 'debug' | 'script';
	readonly name: string;
	// For debug configurations
	readonly launchUri?: string;
	// For scripts
	readonly command?: string;
}

// Extended quick pick item for debug configurations
interface IDebugConfigQuickPickItem extends IQuickPickItem {
	readonly launch: ILaunch;
	readonly configName: string;
}

/**
 * Workbench contribution that adds a split dropdown action to the auxiliary bar title
 * for running scripts or debug configurations.
 */
export class RunScriptContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentSessions.runScript';

	private readonly _menuDisposables = this._register(new DisposableStore());
	private readonly _configListener = this._register(new MutableDisposable());
	private readonly _workspaceListener = this._register(new MutableDisposable());

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IDebugService private readonly _debugService: IDebugService,
		@IInstantiationService _instantiationService: IInstantiationService,
		@IAgentWorkbenchWorkspaceService private readonly _agentWorkbenchWorkspaceService: IAgentWorkbenchWorkspaceService,
	) {
		super();

		this._registerActions();
		this._registerDropdownMenuItems();

		// Listen for debug configuration changes
		this._configListener.value = this._debugService.getConfigurationManager().onDidChangeConfigurationProviders(() => {
			this._registerDropdownMenuItems();
		});

		// Listen for active workspace changes
		this._workspaceListener.value = this._agentWorkbenchWorkspaceService.onDidChangeActiveWorkspaceFolder(() => {
			this._registerDropdownMenuItems();
		});
	}

	private _getStorageKey(): string {
		const activeWorkspaceUri = this._agentWorkbenchWorkspaceService.activeWorkspaceFolderUri;
		if (activeWorkspaceUri) {
			return `${STORAGE_KEY_DEFAULT_RUN_ACTION}.${activeWorkspaceUri.toString()}`;
		}
		return STORAGE_KEY_DEFAULT_RUN_ACTION;
	}

	private _getStoredDefaultAction(): IStoredRunAction | undefined {
		const stored = this._storageService.get(this._getStorageKey(), StorageScope.WORKSPACE);
		if (stored) {
			try {
				return JSON.parse(stored);
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	private _setStoredDefaultAction(action: IStoredRunAction): void {
		this._storageService.store(this._getStorageKey(), JSON.stringify(action), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private _getTooltip(): string {
		const storedAction = this._getStoredDefaultAction();
		if (storedAction) {
			if (storedAction.type === 'debug') {
				return localize('runScript.tooltip.debug', "Run '{0}'", storedAction.name);
			} else {
				return localize('runScript.tooltip.script', "Run '{0}'", storedAction.command || storedAction.name);
			}
		}
		return localize('runScript.tooltip.configure', "Configure Run Action");
	}

	private _registerActions(): void {
		const that = this;

		// Main play action
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: RUN_SCRIPT_ACTION_ID,
					get title() {
						return {
							value: localize('runScript', "Run"),
							original: 'Run'
						};
					},
					tooltip: that._getTooltip(),
					icon: Codicon.play,
					category: localize2('agentSessions', 'Agent Sessions'),
					menu: [{
						id: MenuId.AuxiliaryBarTitle,
						group: 'navigation',
						order: 0,
						when: ContextKeyExpr.true()
					}]
				});
			}

			async run(accessor: ServicesAccessor): Promise<void> {
				const storedAction = that._getStoredDefaultAction();
				if (storedAction) {
					await that._executeStoredAction(accessor, storedAction);
				} else {
					// Open quick pick to configure default
					await that._showConfigureQuickPick(accessor);
				}
			}
		}));

		// Configure default action (shown in dropdown)
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: CONFIGURE_DEFAULT_RUN_ACTION_ID,
					title: localize2('configureDefaultRunAction', "Configure Default Run Action..."),
					category: localize2('agentSessions', 'Agent Sessions'),
					menu: [{
						id: RunScriptDropdownMenuId,
						group: '0_configure',
						order: 0
					}]
				});
			}

			async run(accessor: ServicesAccessor): Promise<void> {
				await that._showConfigureQuickPick(accessor);
			}
		}));
	}

	private _registerDropdownMenuItems(): void {
		this._menuDisposables.clear();

		const configManager = this._debugService.getConfigurationManager();
		const allConfigs = configManager.getAllConfigurations();

		// Filter to only show configurations from the active workspace
		const activeWorkspaceUri = this._agentWorkbenchWorkspaceService.activeWorkspaceFolderUri;
		const filteredConfigs = activeWorkspaceUri
			? allConfigs.filter(config => this._isLaunchFromWorkspace(config.launch, activeWorkspaceUri))
			: [];

		let order = 1;
		for (const { launch, name } of filteredConfigs) {
			const actionId = `${RUN_DEBUG_CONFIGURATION_PREFIX}${launch.uri.toString()}.${name}`;
			const that = this;

			this._menuDisposables.add(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: actionId,
						title: name,
						category: localize2('debug', 'Debug'),
						menu: [{
							id: RunScriptDropdownMenuId,
							group: '1_debug',
							order: order++
						}]
					});
				}

				async run(accessor: ServicesAccessor): Promise<void> {
					const debugService = accessor.get(IDebugService);
					const storedAction: IStoredRunAction = {
						type: 'debug',
						name,
						launchUri: launch.uri.toString()
					};
					that._setStoredDefaultAction(storedAction);
					await debugService.startDebugging(launch, name);
				}
			}));
		}
	}

	private async _showConfigureQuickPick(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const debugService = accessor.get(IDebugService);

		const configManager = debugService.getConfigurationManager();
		const allConfigs = configManager.getAllConfigurations();

		// Filter to only show configurations from the active workspace
		const activeWorkspaceUri = this._agentWorkbenchWorkspaceService.activeWorkspaceFolderUri;
		const filteredConfigs = activeWorkspaceUri
			? allConfigs.filter(config => this._isLaunchFromWorkspace(config.launch, activeWorkspaceUri))
			: [];

		const items: Array<IQuickPickItem | IQuickPickSeparator | IDebugConfigQuickPickItem> = [];

		// Add script input option
		const enterCommandItem: IQuickPickItem = {
			label: localize('enterCommand', "$(terminal) Enter a Command..."),
			alwaysShow: true,
			id: 'enterCommand'
		};
		items.push(enterCommandItem);

		// Add separator
		if (filteredConfigs.length > 0) {
			items.push({
				type: 'separator',
				label: localize('debugConfigurations', "Debug Configurations")
			});

			// Add debug configurations
			for (const { launch, name } of filteredConfigs) {
				const debugItem: IDebugConfigQuickPickItem = {
					label: `$(debug-alt) ${name}`,
					description: launch.name,
					id: `debug:${launch.uri.toString()}:${name}`,
					launch,
					configName: name
				};
				items.push(debugItem);
			}
		}

		const pick = await quickInputService.pick(items, {
			placeHolder: localize('selectRunAction', "Select a default run action"),
			matchOnDescription: true
		});

		if (!pick) {
			return;
		}

		if (pick.id === 'enterCommand') {
			// Show input box for command
			const command = await quickInputService.input({
				placeHolder: localize('enterCommandPlaceholder', "Enter command (e.g., npm run dev)"),
				prompt: localize('enterCommandPrompt', "This command will be run in the integrated terminal")
			});

			if (command) {
				const storedAction: IStoredRunAction = {
					type: 'script',
					name: command,
					command
				};
				this._setStoredDefaultAction(storedAction);
				await this._runScript(accessor, command);
			}
		} else if (pick.id?.startsWith('debug:')) {
			const debugPick = pick as IDebugConfigQuickPickItem;
			const storedAction: IStoredRunAction = {
				type: 'debug',
				name: debugPick.configName,
				launchUri: debugPick.launch.uri.toString()
			};
			this._setStoredDefaultAction(storedAction);
			await debugService.startDebugging(debugPick.launch, debugPick.configName);
		}
	}

	private async _executeStoredAction(accessor: ServicesAccessor, action: IStoredRunAction): Promise<void> {
		if (action.type === 'debug') {
			const debugService = accessor.get(IDebugService);
			const configManager = debugService.getConfigurationManager();

			// Find the launch configuration
			const launches = configManager.getLaunches();
			const launch = launches.find(l => l.uri.toString() === action.launchUri);

			if (launch) {
				await debugService.startDebugging(launch, action.name);
			} else {
				// Launch configuration no longer exists, show quick pick
				await this._showConfigureQuickPick(accessor);
			}
		} else if (action.type === 'script' && action.command) {
			await this._runScript(accessor, action.command);
		}
	}

	private async _runScript(accessor: ServicesAccessor, command: string): Promise<void> {
		const terminalService = accessor.get(ITerminalService);

		// Get the active workspace folder as cwd
		const cwd = this._agentWorkbenchWorkspaceService.activeWorkspaceFolderUri;

		// Create a new terminal and run the command
		const terminal = await terminalService.createTerminal({
			location: TerminalLocation.Panel,
			config: {
				name: command
			},
			cwd
		});

		terminal.sendText(command, true);
		await terminalService.revealTerminal(terminal);
	}

	private _isLaunchFromWorkspace(launch: ILaunch, workspaceUri: URI): boolean {
		// Check if the launch configuration belongs to the given workspace folder
		// The launch.uri points to the launch.json file, which should be in the .vscode folder of the workspace
		return isEqualOrParent(launch.uri, workspaceUri);
	}
}
