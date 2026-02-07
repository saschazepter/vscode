/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ChatViewId } from '../chat.js';
import { CHAT_CATEGORY, CHAT_CONFIG_MENU_ID } from '../actions/chatActions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { HOOK_TYPES, HookType, getEffectiveCommandFieldKey } from '../../common/promptSyntax/hookSchema.js';
import { HOOKS_FILENAME } from '../../common/promptSyntax/config/promptFileLocations.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextEditorSelection } from '../../../../../platform/editor/common/editor.js';
import { findHookCommandSelection, parseAllHookFiles, IParsedHook } from './hookUtils.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { askForPromptSourceFolder } from './pickers/askForPromptSourceFolder.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IBulkEditService, ResourceTextEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { getCodeEditor } from '../../../../../editor/browser/editorBrowser.js';

/**
 * Action ID for the `Configure Hooks` action.
 */
const CONFIGURE_HOOKS_ACTION_ID = 'workbench.action.chat.configure.hooks';

interface IHookTypeQuickPickItem extends IQuickPickItem {
	readonly hookType: typeof HOOK_TYPES[number];
}

interface IHookQuickPickItem extends IQuickPickItem {
	readonly hookEntry?: IParsedHook;
	readonly isAddNewHook?: boolean;
}

interface IHookFileQuickPickItem extends IQuickPickItem {
	readonly fileUri?: URI;
	readonly isCreateNewFile?: boolean;
}

class ManageHooksAction extends Action2 {
	constructor() {
		super({
			id: CONFIGURE_HOOKS_ACTION_ID,
			title: localize2('configure-hooks', "Configure Hooks..."),
			shortTitle: localize2('configure-hooks.short', "Hooks"),
			icon: Codicon.zap,
			f1: true,
			precondition: ChatContextKeys.enabled,
			category: CHAT_CATEGORY,
			menu: {
				id: CHAT_CONFIG_MENU_ID,
				when: ContextKeyExpr.and(ChatContextKeys.enabled, ContextKeyExpr.equals('view', ChatViewId)),
				order: 12,
				group: '1_level'
			}
		});
	}

	public override async run(
		accessor: ServicesAccessor,
	): Promise<void> {
		const promptsService = accessor.get(IPromptsService);
		const quickInputService = accessor.get(IQuickInputService);
		const fileService = accessor.get(IFileService);
		const labelService = accessor.get(ILabelService);
		const editorService = accessor.get(IEditorService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const pathService = accessor.get(IPathService);
		const instaService = accessor.get(IInstantiationService);
		const notificationService = accessor.get(INotificationService);
		const bulkEditService = accessor.get(IBulkEditService);

		// Get workspace root and user home for path resolution
		const workspaceFolder = workspaceService.getWorkspace().folders[0];
		const workspaceRootUri = workspaceFolder?.uri;
		const userHomeUri = await pathService.userHome();
		const userHome = userHomeUri.fsPath ?? userHomeUri.path;

		// Step 1: Show all lifecycle events
		const hookTypeItems: IHookTypeQuickPickItem[] = HOOK_TYPES.map(hookType => ({
			label: hookType.label,
			description: hookType.description,
			hookType
		}));

		const selectedHookType = await quickInputService.pick(hookTypeItems, {
			placeHolder: localize('commands.hooks.selectEvent.placeholder', 'Select a lifecycle event'),
			title: localize('commands.hooks.title', 'Hooks')
		});

		if (!selectedHookType) {
			return;
		}

		// Parse all hook files to get existing hooks
		const hookEntries = await parseAllHookFiles(
			promptsService,
			fileService,
			labelService,
			workspaceRootUri,
			userHome,
			CancellationToken.None
		);

		// Filter hooks by the selected type
		const hooksOfType = hookEntries.filter(h => h.hookType === selectedHookType.hookType.id);

		// Step 2: Show "Add new hook" + existing hooks of this type
		const hookItems: (IHookQuickPickItem | IQuickPickSeparator)[] = [];

		// Add "Add new hook" option at the top
		hookItems.push({
			label: `$(plus) ${localize('commands.addNewHook.label', 'Add new hook...')}`,
			isAddNewHook: true,
			alwaysShow: true
		});

		// Add existing hooks
		if (hooksOfType.length > 0) {
			hookItems.push({
				type: 'separator',
				label: localize('existingHooks', "Existing Hooks")
			});

			for (const entry of hooksOfType) {
				const description = labelService.getUriLabel(entry.fileUri, { relative: true });
				hookItems.push({
					label: entry.commandLabel,
					description,
					hookEntry: entry
				});
			}
		}

		// Auto-execute if only "Add new hook" is available (no existing hooks)
		let selectedHook: IHookQuickPickItem | undefined;
		if (hooksOfType.length === 0) {
			selectedHook = hookItems[0] as IHookQuickPickItem;
		} else {
			selectedHook = await quickInputService.pick(hookItems, {
				placeHolder: localize('commands.hooks.selectHook.placeholder', 'Select a hook to open or add a new one'),
				title: selectedHookType.hookType.label
			});
		}

		if (!selectedHook) {
			return;
		}

		// Handle clicking on existing hook (focus into command)
		if (selectedHook.hookEntry) {
			const entry = selectedHook.hookEntry;
			let selection: ITextEditorSelection | undefined;

			// Determine the command field name to highlight based on current platform
			const commandFieldName = getEffectiveCommandFieldKey(entry.command);

			// Try to find the command field to highlight
			if (commandFieldName) {
				try {
					const content = await fileService.readFile(entry.fileUri);
					selection = findHookCommandSelection(
						content.value.toString(),
						entry.originalHookTypeId,
						entry.index,
						commandFieldName
					);
				} catch {
					// Ignore errors and just open without selection
				}
			}

			await editorService.openEditor({
				resource: entry.fileUri,
				options: {
					selection,
					pinned: false
				}
			});
			return;
		}

		// Step 3: Handle "Add new hook" - show create new file + existing hook files
		if (selectedHook.isAddNewHook) {
			// Get existing hook files
			const hookFiles = await promptsService.listPromptFiles(PromptsType.hook, CancellationToken.None);

			const fileItems: (IHookFileQuickPickItem | IQuickPickSeparator)[] = [];

			// Add "Create new hook config file" option at the top
			fileItems.push({
				label: `$(new-file) ${localize('commands.createNewHookFile.label', 'Create new hook config file...')}`,
				isCreateNewFile: true,
				alwaysShow: true
			});

			// Add existing hook files
			if (hookFiles.length > 0) {
				fileItems.push({
					type: 'separator',
					label: localize('existingHookFiles', "Existing Hook Files")
				});

				for (const hookFile of hookFiles) {
					const relativePath = labelService.getUriLabel(hookFile.uri, { relative: true });
					fileItems.push({
						label: relativePath,
						fileUri: hookFile.uri
					});
				}
			}

			// Auto-execute if no existing hook files
			let selectedFile: IHookFileQuickPickItem | undefined;
			if (hookFiles.length === 0) {
				selectedFile = fileItems[0] as IHookFileQuickPickItem;
			} else {
				selectedFile = await quickInputService.pick(fileItems, {
					placeHolder: localize('commands.hooks.selectFile.placeholder', 'Select a hook file or create a new one'),
					title: localize('commands.hooks.addHook.title', 'Add Hook')
				});
			}

			if (!selectedFile) {
				return;
			}

			// Handle creating new hook config file
			if (selectedFile.isCreateNewFile) {
				const selectedFolder = await instaService.invokeFunction(askForPromptSourceFolder, PromptsType.hook);
				if (!selectedFolder) {
					return;
				}

				// Create the hooks folder if it doesn't exist
				await fileService.createFolder(selectedFolder.uri);

				// Use fixed hooks.json filename
				const hookFileUri = URI.joinPath(selectedFolder.uri, HOOKS_FILENAME);

				// Create new hook file with the selected hook type
				const hooksContent = {
					hooks: {
						[selectedHookType.hookType.id]: [
							{
								type: 'command',
								command: ''
							}
						]
					}
				};

				const jsonContent = JSON.stringify(hooksContent, null, '\t');
				await fileService.writeFile(hookFileUri, VSBuffer.fromString(jsonContent));

				// Find the selection for the new hook's command field
				const selection = findHookCommandSelection(jsonContent, selectedHookType.hookType.id, 0, 'command');

				// Open editor with selection
				await editorService.openEditor({
					resource: hookFileUri,
					options: {
						selection,
						pinned: false
					}
				});
				return;
			}

			// Handle adding hook to existing file
			if (selectedFile.fileUri) {
				await this.addHookToFile(
					selectedFile.fileUri,
					selectedHookType.hookType.id as HookType,
					fileService,
					editorService,
					notificationService,
					bulkEditService
				);
			}
		}
	}

	/**
	 * Adds a hook to an existing hook file.
	 */
	private async addHookToFile(
		hookFileUri: URI,
		hookTypeId: HookType,
		fileService: IFileService,
		editorService: IEditorService,
		notificationService: INotificationService,
		bulkEditService: IBulkEditService
	): Promise<void> {
		// Parse existing file
		let hooksContent: { hooks: Record<string, unknown[]> };
		const fileExists = await fileService.exists(hookFileUri);

		if (fileExists) {
			const existingContent = await fileService.readFile(hookFileUri);
			try {
				hooksContent = JSON.parse(existingContent.value.toString());
				// Ensure hooks object exists
				if (!hooksContent.hooks) {
					hooksContent.hooks = {};
				}
			} catch {
				// If parsing fails, show error and open file for user to fix
				notificationService.error(localize('commands.new.hook.parseError', "Failed to parse existing hooks.json. Please fix the JSON syntax errors and try again."));
				await editorService.openEditor({ resource: hookFileUri });
				return;
			}
		} else {
			// Create new structure
			hooksContent = { hooks: {} };
		}

		// Add the new hook entry (append if hook type already exists)
		const newHookEntry = {
			type: 'command',
			command: ''
		};
		let newHookIndex: number;
		if (!hooksContent.hooks[hookTypeId]) {
			hooksContent.hooks[hookTypeId] = [newHookEntry];
			newHookIndex = 0;
		} else {
			hooksContent.hooks[hookTypeId].push(newHookEntry);
			newHookIndex = hooksContent.hooks[hookTypeId].length - 1;
		}

		// Write the file
		const jsonContent = JSON.stringify(hooksContent, null, '\t');

		// Check if the file is already open in an editor
		const existingEditor = editorService.editors.find(e => isEqual(e.resource, hookFileUri));

		if (existingEditor) {
			// File is already open - first focus the editor, then update its model directly
			await editorService.openEditor({
				resource: hookFileUri,
				options: {
					pinned: false
				}
			});

			// Get the code editor and update its content directly
			const editor = getCodeEditor(editorService.activeTextEditorControl);
			if (editor && editor.hasModel() && isEqual(editor.getModel().uri, hookFileUri)) {
				const model = editor.getModel();
				// Apply the full content replacement using executeEdits
				model.pushEditOperations([], [{
					range: model.getFullModelRange(),
					text: jsonContent
				}], () => null);

				// Find and apply the selection
				const selection = findHookCommandSelection(jsonContent, hookTypeId, newHookIndex, 'command');
				if (selection && selection.endLineNumber !== undefined && selection.endColumn !== undefined) {
					editor.setSelection({
						startLineNumber: selection.startLineNumber,
						startColumn: selection.startColumn,
						endLineNumber: selection.endLineNumber,
						endColumn: selection.endColumn
					});
					editor.revealLineInCenter(selection.startLineNumber);
				}
			}
		} else {
			// File is not currently open in an editor
			if (!fileExists) {
				// File doesn't exist - write new file directly and open
				await fileService.writeFile(hookFileUri, VSBuffer.fromString(jsonContent));
			} else {
				// File exists but isn't open - open it first, then use bulk edit for undo support
				await editorService.openEditor({
					resource: hookFileUri,
					options: { pinned: false }
				});

				// Apply the edit via bulk edit service for proper undo support
				await bulkEditService.apply([
					new ResourceTextEdit(hookFileUri, { range: new Range(1, 1, Number.MAX_SAFE_INTEGER, 1), text: jsonContent })
				], { label: localize('addHook', "Add Hook") });
			}

			// Find the selection for the new hook's command field
			const selection = findHookCommandSelection(jsonContent, hookTypeId, newHookIndex, 'command');

			// Open editor with selection (or re-focus if already open)
			await editorService.openEditor({
				resource: hookFileUri,
				options: {
					selection,
					pinned: false
				}
			});
		}
	}
}

/**
 * Helper to register the `Manage Hooks` action.
 */
export function registerHookActions(): void {
	registerAction2(ManageHooksAction);
}
