/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ActionViewItem, type IActionViewItemOptions } from '../../base/browser/ui/actionbar/actionViewItems.js';
import type { IAction } from '../../base/common/actions.js';
import { Codicon } from '../../base/common/codicons.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../base/common/observable.js';
import { localize, localize2 } from '../../nls.js';
import { IActionViewItemService } from '../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../platform/actions/common/actions.js';
import { CODEX_AGENT_PROVIDER_ID } from '../../platform/agentHost/common/agentService.js';
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { EditorInput } from '../../workbench/common/editor/editorInput.js';
import { IEditorFactoryRegistry, IEditorSerializer, EditorExtensions } from '../../workbench/common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../workbench/browser/editor.js';
import { IsSessionsWindowContext } from '../../workbench/common/contextkeys.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../workbench/services/environment/common/environmentService.js';
import { Menus } from './menus.js';
import { CodexSettingsEditor } from './codexSettingsEditor.js';
import { CodexSettingsEditorInput } from './codexSettingsEditorInput.js';
import { SessionTypeContext } from '../common/contextkeys.js';
import type { IActiveSession } from '../services/sessions/common/sessionsManagement.js';
import { ISessionContext } from '../services/sessions/browser/sessionContext.js';

const OPEN_CODEX_SETTINGS_COMMAND_ID = 'sessions.agentHost.manageCodexAccount';

interface ICodexSettingsActionContext {
	readonly providerId?: string;
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(CodexSettingsEditor, CodexSettingsEditor.ID, localize('codexSettingsEditor', "Codex Settings Editor")),
	[new SyncDescriptor(CodexSettingsEditorInput)]
);

class CodexSettingsEditorInputSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof CodexSettingsEditorInput;
	}

	serialize(input: CodexSettingsEditorInput): string {
		return JSON.stringify({ providerId: input.providerId });
	}

	deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): CodexSettingsEditorInput {
		let providerId: string | undefined;
		try {
			const data = JSON.parse(serializedEditorInput) as { providerId?: string };
			providerId = data.providerId;
		} catch {
			// Older or malformed serialized inputs reopen against the active Codex host.
		}
		return new CodexSettingsEditorInput(providerId);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	CodexSettingsEditorInput.ID,
	CodexSettingsEditorInputSerializer
);

registerAction2(class extends Action2 {
	constructor() {
		const isCodexSession = ContextKeyExpr.equals(SessionTypeContext.key, CODEX_AGENT_PROVIDER_ID);
		const isCodexWorkbenchChat = ContextKeyExpr.equals('chatAgentHostProviderId', CODEX_AGENT_PROVIDER_ID);
		super({
			id: OPEN_CODEX_SETTINGS_COMMAND_ID,
			title: localize2('openCodexSettings', "Codex: Open Settings"),
			tooltip: localize2('openCodexSettingsTooltip', "Configure Codex"),
			icon: Codicon.settingsGear,
			f1: true,
			menu: [{
				id: Menus.NewSessionControl,
				group: 'navigation',
				order: 4,
				when: isCodexSession,
			}, {
				id: MenuId.ChatInputSecondary,
				group: 'navigation',
				order: 13,
				when: isCodexSession,
			}, {
				id: MenuId.ChatInputSecondary,
				group: 'navigation',
				order: 1.05,
				when: ContextKeyExpr.and(isCodexWorkbenchChat, IsSessionsWindowContext.negate()),
			}],
		});
	}

	override run(accessor: ServicesAccessor, context?: ICodexSettingsActionContext): Promise<unknown> {
		return accessor.get(IEditorService).openEditor(new CodexSettingsEditorInput(context?.providerId), { pinned: true });
	}
});

class CodexSettingsActionViewItem extends ActionViewItem {
	constructor(
		action: IAction,
		options: IActionViewItemOptions,
		session: IObservable<IActiveSession | undefined> | undefined,
	) {
		super(undefined, action, { ...options, icon: true, label: false });
		if (session) {
			this._register(autorun(reader => {
				this.setActionContext({ providerId: session.read(reader)?.providerId } satisfies ICodexSettingsActionContext);
			}));
		}
	}

	override render(container: HTMLElement): void {
		container.classList.add('codex-settings-action-item');
		super.render(container);
	}
}

class CodexSettingsActionViewItemContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.contrib.codexSettingsActionViewItem';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
	) {
		super();
		for (const menu of [Menus.NewSessionControl, MenuId.ChatInputSecondary]) {
			this._register(actionViewItemService.register(
				menu,
				OPEN_CODEX_SETTINGS_COMMAND_ID,
				(action, options, scopedInstantiationService) => {
					const session = scopedInstantiationService.invokeFunction(accessor => accessor.get(IWorkbenchEnvironmentService).isSessionsWindow
						? accessor.get(ISessionContext).session
						: undefined);
					return new CodexSettingsActionViewItem(action, options, session);
				},
			));
		}
	}
}

registerWorkbenchContribution2(CodexSettingsActionViewItemContribution.ID, CodexSettingsActionViewItemContribution, WorkbenchPhase.AfterRestored);
