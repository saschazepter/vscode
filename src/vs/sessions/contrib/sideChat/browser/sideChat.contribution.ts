/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { SideChatEditor } from './sideChatEditor.js';
import { SideChatEditorInput, SideChatEditorSerializer } from './sideChatEditorInput.js';

class SideChatEditorContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.sideChatEditor';

	constructor() {
		super();

		this._register(Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
			EditorPaneDescriptor.create(SideChatEditor, SideChatEditor.ID, localize('sideChatEditor.label', "Side Chat")),
			[new SyncDescriptor(SideChatEditorInput)]
		));

		this._register(Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
			SideChatEditorInput.ID,
			SideChatEditorSerializer
		));
	}
}

registerWorkbenchContribution2(SideChatEditorContribution.ID, SideChatEditorContribution, WorkbenchPhase.BlockStartup);
