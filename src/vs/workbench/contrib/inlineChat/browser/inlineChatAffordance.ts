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
import { URI } from '../../../../base/common/uri.js';
import { AgentFeedbackAffordance } from './inlineChatAgentFeedbackAffordance.js';
import { agentSessionContainsResource, editingEntriesContainResource } from '../../chat/browser/sessionResourceMatching.js';
import { CodeActionController } from '../../../../editor/contrib/codeAction/browser/codeActionController.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { generateUuid } from '../../../../base/common/uuid.js';

type AgentSessionResourceContext = {
	readonly sessionResource: URI;
	readonly resourceUri: URI;
};

type AffordanceMode = 'off' | 'gutter' | 'editor' | 'feedback';

type InlineChatAffordanceEvent = {
	mode: string;
	id: string;
};

type InlineChatAffordanceClassification = {
	mode: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The affordance mode: gutter or editor.' };
	id: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'UUID to correlate shown and selected events.' };
	owner: 'jrieken';
	comment: 'Tracks when the inline chat affordance is shown or selected.';
};

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
				if (editingEntriesContainResource(entries, resourceUri)) {
					return { sessionResource: editingSession.chatSessionResource, resourceUri };
				}
			}

			observableSignalFromEvent(this, agentSessionsService.model.onDidChangeSessions).read(r);
			for (const session of agentSessionsService.model.sessions) {
				if (agentSessionContainsResource(session, resourceUri)) {
					return { sessionResource: session.resource, resourceUri };
				}
			}

			return undefined;
		});
	}
}

export class InlineChatAffordance extends Disposable {

	readonly #editor: ICodeEditor;
	readonly #inputWidget: InlineChatInputWidget;
	readonly #instantiationService: IInstantiationService;
	readonly #menuData = observableValue<{ rect: DOMRect; above: boolean; lineNumber: number } | undefined>(this, undefined);

	constructor(
		editor: ICodeEditor,
		inputWidget: InlineChatInputWidget,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super();
		this.#editor = editor;
		this.#inputWidget = inputWidget;
		this.#instantiationService = instantiationService;

		const editorObs = observableCodeEditor(this.#editor);
		const context = this._store.add(this.#instantiationService.createInstance(InlineChatEditorContext, this.#editor, editorObs));

		const configuredAffordance = observableConfigValue<'off' | 'gutter' | 'editor'>(InlineChatConfigKeys.Affordance, 'off', configurationService);
		const affordanceModeObs = derived<AffordanceMode>(r => context.agentSessionResourceContextObs.read(r) ? 'feedback' : configuredAffordance.read(r));

		// --- Shared selection tracking ---
		const selectionData = this._store.add(this.#instantiationService.createInstance(SelectionTracker, editorObs, this.#editor, context.diffMappings)).selectionData;

		let affordanceId: string | undefined;

		this._store.add(autorun(r => {
			const value = selectionData.read(r);
			if (!value) {
				affordanceId = undefined;
				return;
			}
			affordanceId = generateUuid();
			const mode = configuredAffordance.read(undefined);
			if (mode === 'gutter' || mode === 'editor') {
				telemetryService.publicLog2<InlineChatAffordanceEvent, InlineChatAffordanceClassification>('inlineChatAffordance/shown', { mode, id: affordanceId });
			}
		}));

		this._store.add(this.#instantiationService.createInstance(
			InlineChatGutterAffordance,
			editorObs,
			derived(r => !context.isDiffModifiedEditorObs.read(r) && affordanceModeObs.read(r) === 'gutter' ? selectionData.read(r) : undefined),
			this.#menuData
		));

		const editorAffordance = this.#instantiationService.createInstance(
			InlineChatEditorAffordance,
			this.#editor,
			derived(r => !context.isDiffModifiedEditorObs.read(r) && affordanceModeObs.read(r) === 'editor' ? selectionData.read(r) : undefined)
		);
		this._store.add(editorAffordance);
		this._store.add(editorAffordance.onDidRunAction(() => {
			if (affordanceId) {
				telemetryService.publicLog2<InlineChatAffordanceEvent, InlineChatAffordanceClassification>('inlineChatAffordance/selected', { mode: 'editor', id: affordanceId });
			}
		}));

		this._store.add(this.#instantiationService.createInstance(
			AgentFeedbackAffordance,
			this.#editor, this.#inputWidget, selectionData, context.agentSessionResourceContextObs,
			context.diffMappings, context.isDiffModifiedEditorObs, this.#menuData
		));

		// --- Shared: bridge _menuData → input widget show/hide ---
		this._store.add(autorun(r => {
			const isEditor = configuredAffordance.read(r) === 'editor';
			const controller = CodeActionController.get(this.#editor);
			if (controller) {
				controller.onlyLightBulbWithEmptySelection = isEditor;
			}
		}));

		this._store.add(autorun(r => {
			const data = this.#menuData.read(r);
			if (!data) {
				this.#inputWidget.hideWidget();
				return;
			}

			if (affordanceId) {
				telemetryService.publicLog2<InlineChatAffordanceEvent, InlineChatAffordanceClassification>('inlineChatAffordance/selected', { mode: 'gutter', id: affordanceId });
			}

			// Reveal the line in case it's outside the viewport (e.g., when triggered from sticky scroll)
			this.#editor.revealLineInCenterIfOutsideViewport(data.lineNumber, ScrollType.Immediate);

			const editorDomNode = this.#editor.getDomNode()!;
			const editorRect = editorDomNode.getBoundingClientRect();
			const left = data.rect.left - editorRect.left;

			const isDiff = context.isDiffModifiedEditorObs.read(undefined);
			this.#inputWidget.show(data.lineNumber, left, data.above, { focusInput: !isDiff });
		}));

		this._store.add(autorun(r => {
			const pos = this.#inputWidget.position.read(r);
			if (pos === null) {
				this.#menuData.set(undefined, undefined);
			}
		}));
	}

	async showMenuAtSelection() {
		assertType(this.#editor.hasModel());

		const direction = this.#editor.getSelection().getDirection();
		const position = this.#editor.getPosition();
		const editorDomNode = this.#editor.getDomNode();
		const scrolledPosition = this.#editor.getScrolledVisiblePosition(position);
		const editorRect = editorDomNode.getBoundingClientRect();
		const x = editorRect.left + scrolledPosition.left;
		const y = editorRect.top + scrolledPosition.top;

		this.#menuData.set({
			rect: new DOMRect(x, y, 0, scrolledPosition.height),
			above: direction === SelectionDirection.RTL,
			lineNumber: position.lineNumber
		}, undefined);

		await waitForState(this.#inputWidget.position, pos => pos === null);
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
