/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { runOnChange } from '../../../../base/common/observable.js';

export class SessionBrowserViewController extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionBrowserViewController';

	/**
	 * Tracks browser view inputs with their owning session. The
	 * DisposableMap cleans up lifecycle listeners on deletion/disposal.
	 */
	private readonly _trackedInputs = this._register(new DisposableMap<string, { sessionId: string; dispose: () => void }>());

	constructor(
		@ISessionsManagementService private readonly _sessionManagementService: ISessionsManagementService,
		@IBrowserViewWorkbenchService private readonly _browserViewService: IBrowserViewWorkbenchService,
	) {
		super();

		this._register(this._browserViewService.onDidChangeBrowserViews(() => {
			const known = this._browserViewService.getKnownBrowserViews();
			for (const input of known.values()) {
				this._attachLifecycle(input);
			}
		}));

		// Force-destroy browser views when sessions are removed.
		this._register(this._sessionManagementService.onDidChangeSessions(e => {
			if (e.removed.length === 0 || this._trackedInputs.size === 0) {
				return;
			}

			const removedSessionIds = new Set(e.removed.map(s => s.resource.toString()));
			const known = this._browserViewService.getKnownBrowserViews();
			for (const [id, { sessionId }] of this._trackedInputs) {
				if (removedSessionIds.has(sessionId)) {
					const existingInput = known.get(id);
					if (existingInput instanceof BrowserEditorInput) {
						existingInput.dispose(true);
					}
				}
			}
		}));
	}

	private _attachLifecycle(input: BrowserEditorInput): void {
		if (this._trackedInputs.has(input.id)) {
			return;
		}

		const session = this._sessionManagementService.activeSession.read(undefined);
		if (!session) {
			return; // no session, no lifecycle management needed
		}
		const sessionId = session.resource.toString();

		const store = new DisposableStore();
		this._trackedInputs.set(input.id, { sessionId, dispose: () => store.dispose() });

		// When the owning session is archived, force-dispose the browser view.
		store.add(runOnChange(session.isArchived, (isArchived) => {
			if (isArchived) {
				input.dispose(true);
			}
		}));

		store.add(input.onBeforeDispose(e => {
			const activeSessionId = this._sessionManagementService.activeSession.read(undefined)?.resource.toString();

			// If the input is being disposed, but we are not currently in the owning session,
			// assume a session swap is happening and do not actually dispose the browser yet.
			if (sessionId !== activeSessionId) {
				e.veto();
			}
		}));

		store.add(input.onWillDispose(() => {
			store.dispose();
			this._trackedInputs.deleteAndDispose(input.id);
		}));
	}
}
