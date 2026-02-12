/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, debouncedObservable, derived, IObservable, observableFromEvent, observableSignalFromEvent, observableValue, runOnChange, waitForState } from '../../../../base/common/observable.js';
import { ICodeEditor, IDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { observableCodeEditor, ObservableCodeEditor } from '../../../../editor/browser/observableCodeEditor.js';
import { ScrollType } from '../../../../editor/common/editorCommon.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { InlineChatConfigKeys } from '../common/inlineChat.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { observableConfigValue } from '../../../../platform/observable/common/platformObservableUtils.js';
import { IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';
import { InlineChatEditorAffordance } from './inlineChatEditorAffordance.js';
import { InlineChatInputWidget } from './inlineChatOverlayWidget.js';
import { InlineChatGutterAffordance } from './inlineChatGutterAffordance.js';
import { Selection, SelectionDirection } from '../../../../editor/common/core/selection.js';
import { assertType } from '../../../../base/common/types.js';
import { CursorChangeReason } from '../../../../editor/common/cursorEvents.js';
import { IInlineChatSessionService } from './inlineChatSessionService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { DetailedLineRangeMapping } from '../../../../editor/common/diff/rangeMapping.js';
import { Event } from '../../../../base/common/event.js';
import { IChatEditingService } from '../../chat/common/editing/chatEditingService.js';
import { IAgentSessionsService } from '../../chat/browser/agentSessions/agentSessionsService.js';
import { isIChatSessionFileChange2 } from '../../chat/common/chatSessionsService.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { AgentFeedbackAffordance } from './inlineChatAgentFeedbackAffordance.js';

type AgentSessionResourceContext = {
	readonly sessionResource: URI;
	readonly resourceUri: URI;
};

type AffordanceMode = 'off' | 'gutter' | 'editor' | 'feedback';

class InlineChatEditorContext extends Disposable {

	readonly diffInfoObs: IObservable<{ diffEditor: IDiffEditor } | undefined>;
	readonly diffMappings: IObservable<readonly DetailedLineRangeMapping[] | undefined>;
	readonly isDiffModifiedEditorObs: IObservable<boolean>;
	readonly agentSessionResourceContextObs: IObservable<AgentSessionResourceContext | undefined>;

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _editorObs: ObservableCodeEditor,
		@ICodeEditorService codeEditorService: ICodeEditorService,
		@IChatEditingService chatEditingService: IChatEditingService,
		@IAgentSessionsService agentSessionsService: IAgentSessionsService,
	) {
		super();

		this.diffInfoObs = observableFromEvent<{ diffEditor: IDiffEditor } | undefined>(
			Event.any(codeEditorService.onDiffEditorAdd, codeEditorService.onDiffEditorRemove),
			() => {
				if (!this._editor.getOption(EditorOption.inDiffEditor)) {
					return undefined;
				}
				for (const de of codeEditorService.listDiffEditors()) {
					if (de.getModifiedEditor() === this._editor) {
						return { diffEditor: de };
					}
				}
				return undefined;
			}
		);

		this.diffMappings = derived(r => {
			const info = this.diffInfoObs.read(r);
			if (!info) {
				return undefined;
			}
			observableSignalFromEvent(this, info.diffEditor.onDidUpdateDiff).read(r);
			return info.diffEditor.getDiffComputationResult()?.changes2 ?? [];
		});

		this.isDiffModifiedEditorObs = derived(r => !!this.diffInfoObs.read(r));

		this.agentSessionResourceContextObs = derived(r => {
			const model = this._editorObs.model.read(r);
			if (!model) {
				return undefined;
			}

			const resourceUri = model.uri;

			const editingSessions = chatEditingService.editingSessionsObs.read(r);
			for (const editingSession of editingSessions) {
				const entries = editingSession.entries.read(r);
				for (const entry of entries) {
					if (isEqual(entry.modifiedURI, resourceUri) || isEqual(entry.originalURI, resourceUri)) {
						return { sessionResource: editingSession.chatSessionResource, resourceUri };
					}
				}
			}

			observableSignalFromEvent(this, agentSessionsService.model.onDidChangeSessions).read(r);
			for (const session of agentSessionsService.model.sessions) {
				if (!(session.changes instanceof Array)) {
					continue;
				}

				for (const change of session.changes) {
					if (isIChatSessionFileChange2(change)) {
						if (isEqual(change.uri, resourceUri) || (change.originalUri && isEqual(change.originalUri, resourceUri)) || (change.modifiedUri && isEqual(change.modifiedUri, resourceUri))) {
							return { sessionResource: session.resource, resourceUri };
						}
					} else if (isEqual(change.modifiedUri, resourceUri) || (change.originalUri && isEqual(change.originalUri, resourceUri))) {
						return { sessionResource: session.resource, resourceUri };
					}
				}
			}

			return undefined;
		});
	}
}

export class InlineChatAffordance extends Disposable {

	private readonly _menuData = observableValue<{ rect: DOMRect; above: boolean; lineNumber: number } | undefined>(this, undefined);

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _inputWidget: InlineChatInputWidget,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();

		const editorObs = observableCodeEditor(this._editor);
		const context = this._store.add(this._instantiationService.createInstance(InlineChatEditorContext, this._editor, editorObs));

		const configuredAffordance = observableConfigValue<'off' | 'gutter' | 'editor'>(InlineChatConfigKeys.Affordance, 'off', configurationService);
		const affordanceModeObs = derived<AffordanceMode>(r => context.agentSessionResourceContextObs.read(r) ? 'feedback' : configuredAffordance.read(r));

		// --- Shared selection tracking ---
		const selectionData = this._store.add(this._instantiationService.createInstance(SelectionTracker, editorObs, this._editor, context.diffMappings)).selectionData;

		this._store.add(this._instantiationService.createInstance(
			InlineChatGutterAffordance,
			editorObs,
			derived(r => !context.isDiffModifiedEditorObs.read(r) && affordanceModeObs.read(r) === 'gutter' ? selectionData.read(r) : undefined),
			this._menuData
		));

		this._store.add(this._instantiationService.createInstance(
			InlineChatEditorAffordance,
			this._editor,
			derived(r => !context.isDiffModifiedEditorObs.read(r) && affordanceModeObs.read(r) === 'editor' ? selectionData.read(r) : undefined)
		));

		this._store.add(this._instantiationService.createInstance(
			AgentFeedbackAffordance,
			this._editor, this._inputWidget, selectionData, context.agentSessionResourceContextObs,
			context.diffMappings, context.isDiffModifiedEditorObs, this._menuData
		));

		// --- Shared: bridge _menuData → input widget show/hide ---
		this._store.add(autorun(r => {
			const data = this._menuData.read(r);
			if (!data) {
				this._inputWidget.hideWidget();
				return;
			}

			this._editor.revealLineInCenterIfOutsideViewport(data.lineNumber, ScrollType.Immediate);

			const editorDomNode = this._editor.getDomNode()!;
			const editorRect = editorDomNode.getBoundingClientRect();
			const left = data.rect.left - editorRect.left;

			const isDiff = context.isDiffModifiedEditorObs.read(undefined);
			this._inputWidget.show(data.lineNumber, left, data.above, { focusInput: !isDiff });
		}));

		this._store.add(autorun(r => {
			const pos = this._inputWidget.position.read(r);
			if (pos === null) {
				this._menuData.set(undefined, undefined);
			}
		}));
	}

	async showMenuAtSelection() {
		assertType(this._editor.hasModel());

		const direction = this._editor.getSelection().getDirection();
		const position = this._editor.getPosition();
		const editorDomNode = this._editor.getDomNode();
		const scrolledPosition = this._editor.getScrolledVisiblePosition(position);
		const editorRect = editorDomNode.getBoundingClientRect();
		const x = editorRect.left + scrolledPosition.left;
		const y = editorRect.top + scrolledPosition.top;

		this._menuData.set({
			rect: new DOMRect(x, y, 0, scrolledPosition.height),
			above: direction === SelectionDirection.RTL,
			lineNumber: position.lineNumber
		}, undefined);

		await waitForState(this._inputWidget.position, pos => pos === null);
	}
}

// --- Selection Tracking -------------------------------------------------------

/**
 * Tracks the user's explicit selection in the editor.
 * In diff editors, also accepts empty selections on diff-changed lines.
 */
class SelectionTracker extends Disposable {

	readonly selectionData = observableValue<Selection | undefined>(this, undefined);

	constructor(
		editorObs: ObservableCodeEditor,
		editor: ICodeEditor,
		diffMappings: IObservable<readonly DetailedLineRangeMapping[] | undefined>,
		@IChatEntitlementService chatEntitlementService: IChatEntitlementService,
		@IInlineChatSessionService inlineChatSessionService: IInlineChatSessionService,
	) {
		super();

		const debouncedSelection = debouncedObservable(editorObs.cursorSelection, 500);
		let explicitSelection = false;

		this._store.add(runOnChange(editorObs.selections, (_value, _prev, events) => {
			explicitSelection = events.every(e => e.reason === CursorChangeReason.Explicit);
			this.selectionData.set(undefined, undefined);
		}));

		this._store.add(autorun(r => {
			const value = debouncedSelection.read(r);
			if (!value || !explicitSelection) {
				this.selectionData.set(undefined, undefined);
				return;
			}

			if (value.isEmpty()) {
				const mappings = diffMappings.read(r);
				if (mappings) {
					const cursorLine = value.getPosition().lineNumber;
					if (mappings.some(m => m.modified.contains(cursorLine))) {
						this.selectionData.set(value, undefined);
						return;
					}
				}
				this.selectionData.set(undefined, undefined);
				return;
			}

			if (editor.getModel()?.getValueInRange(value).match(/^\s+$/)) {
				this.selectionData.set(undefined, undefined);
				return;
			}
			this.selectionData.set(value, undefined);
		}));

		this._store.add(autorun(r => {
			if (chatEntitlementService.sentimentObs.read(r).hidden) {
				this.selectionData.set(undefined, undefined);
			}
		}));

		const hasSessionObs = derived(r => {
			observableSignalFromEvent(this, inlineChatSessionService.onDidChangeSessions).read(r);
			const model = editorObs.model.read(r);
			return model ? inlineChatSessionService.getSessionByTextModel(model.uri) !== undefined : false;
		});

		this._store.add(autorun(r => {
			if (hasSessionObs.read(r)) {
				this.selectionData.set(undefined, undefined);
			}
		}));
	}
}
