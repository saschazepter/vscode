/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { ExtHostAgentEditorCommentsShape, ExtHostContext, IAgentEditorCommentDto, MainContext, MainThreadAgentEditorCommentsShape } from '../../../../workbench/api/common/extHost.protocol.js';
import { extHostNamedCustomer, IExtHostContext } from '../../../../workbench/services/extensions/common/extHostCustomers.js';
import { IAgentFeedbackService } from './agentFeedbackService.js';
import { getSessionEditorComments } from './sessionEditorComments.js';

/**
 * Bridges the workbench's {@link IAgentFeedbackService} (the same store the code
 * editor renders its session comments from) to the extension host, so custom
 * editors (e.g. the Markdown editor) can render and contribute the same
 * comments. Lives in the sessions layer because the feedback service does; the
 * extension-host protocol it implements is declared in the workbench api layer.
 */
@extHostNamedCustomer(MainContext.MainThreadAgentEditorComments)
export class MainThreadAgentEditorComments implements MainThreadAgentEditorCommentsShape {

	private readonly _proxy: ExtHostAgentEditorCommentsShape;
	private readonly _resources = new Map<number, URI>();
	private readonly _disposables = new DisposableMap<number>();

	constructor(
		extHostContext: IExtHostContext,
		@IAgentFeedbackService private readonly _agentFeedbackService: IAgentFeedbackService,
	) {
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostAgentEditorComments);
	}

	async $createAgentEditorComments(handle: number, uri: UriComponents): Promise<void> {
		const resource = URI.revive(uri);
		this._resources.set(handle, resource);

		const store = new DisposableStore();
		store.add(this._agentFeedbackService.onDidChangeFeedback(() => this._sendComments(handle)));
		this._disposables.set(handle, store);

		this._sendComments(handle);
	}

	async $addComment(handle: number, range: IRange, body: string): Promise<void> {
		const resource = this._resources.get(handle);
		if (!resource) {
			return;
		}
		const session = this._agentFeedbackService.getSessionForFile(resource);
		if (!session) {
			return;
		}
		this._agentFeedbackService.addFeedback(session.resource, resource, range, body);
	}

	async $disposeAgentEditorComments(handle: number): Promise<void> {
		this._resources.delete(handle);
		this._disposables.deleteAndDispose(handle);
	}

	private _sendComments(handle: number): void {
		const resource = this._resources.get(handle);
		if (!resource) {
			return;
		}

		const session = this._agentFeedbackService.getSessionForFile(resource);
		const comments: IAgentEditorCommentDto[] = [];
		if (session) {
			const sessionComments = getSessionEditorComments(session.resource, this._agentFeedbackService.getFeedback(session.resource));
			for (const comment of sessionComments) {
				if (isEqual(comment.resourceUri, resource)) {
					comments.push({ id: comment.id, range: comment.range, body: comment.text });
				}
			}
		}
		this._proxy.$acceptAgentEditorComments(handle, comments);
	}

	dispose(): void {
		this._disposables.dispose();
		this._resources.clear();
	}
}
