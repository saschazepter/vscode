/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { Comment, CommentThread, CommentThreadCollapsibleState, CommentThreadState, CommentInput } from '../../../../../editor/common/languages.js';
import { createDecorator, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICommentController, ICommentInfo, ICommentService, INotebookCommentInfo } from '../../../comments/browser/commentService.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { registerAction2, Action2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';

// --- Types --------------------------------------------------------------------

export interface IDiffComment {
	readonly id: string;
	readonly text: string;
	readonly resourceUri: URI;
	readonly range: IRange;
	readonly sessionResource: URI;
}

export interface IDiffCommentsChangeEvent {
	readonly sessionResource: URI;
	readonly comments: readonly IDiffComment[];
}

// --- Service Interface --------------------------------------------------------

export const IDiffCommentsService = createDecorator<IDiffCommentsService>('diffCommentsService');

export interface IDiffCommentsService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeComments: Event<IDiffCommentsChangeEvent>;

	/**
	 * Add a comment for the given session.
	 */
	addComment(sessionResource: URI, resourceUri: URI, range: IRange, text: string): IDiffComment;

	/**
	 * Remove a single comment.
	 */
	removeComment(sessionResource: URI, commentId: string): void;

	/**
	 * Get all comments for a session.
	 */
	getComments(sessionResource: URI): readonly IDiffComment[];

	/**
	 * Clear all comments for a session (e.g., after sending).
	 */
	clearComments(sessionResource: URI): void;
}

// --- Implementation -----------------------------------------------------------

const DIFF_COMMENTS_OWNER = 'diffCommentsController';
const DIFF_COMMENTS_CONTEXT_VALUE = 'diffComments';

export class DiffCommentsService extends Disposable implements IDiffCommentsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeComments = this._store.add(new Emitter<IDiffCommentsChangeEvent>());
	readonly onDidChangeComments = this._onDidChangeComments.event;

	/** sessionResource → comments */
	private readonly _commentsBySession = new Map<string, IDiffComment[]>();

	private _controllerRegistered = false;
	private _nextThreadHandle = 1;

	constructor(
		@ICommentService private readonly _commentService: ICommentService,
	) {
		super();
	}

	private _ensureController(): void {
		if (this._controllerRegistered) {
			return;
		}
		this._controllerRegistered = true;

		const self = this;

		const controller: ICommentController = {
			id: DIFF_COMMENTS_OWNER,
			label: 'Diff Comments',
			features: {},
			contextValue: DIFF_COMMENTS_CONTEXT_VALUE,
			owner: DIFF_COMMENTS_OWNER,
			activeComment: undefined,
			createCommentThreadTemplate: async () => { },
			updateCommentThreadTemplate: async () => { },
			deleteCommentThreadMain: () => { },
			toggleReaction: async () => { },
			getDocumentComments: async (resource: URI, _token: CancellationToken): Promise<ICommentInfo<IRange>> => {
				// Return threads for this resource from all sessions
				const threads: CommentThread<IRange>[] = [];
				for (const [, sessionComments] of self._commentsBySession) {
					for (const c of sessionComments) {
						if (c.resourceUri.toString() === resource.toString()) {
							threads.push(self._createThread(c));
						}
					}
				}
				return {
					threads,
					commentingRanges: { ranges: [], resource, fileComments: false },
					uniqueOwner: DIFF_COMMENTS_OWNER,
				};
			},
			getNotebookComments: async (_resource: URI, _token: CancellationToken): Promise<INotebookCommentInfo> => {
				return { threads: [], uniqueOwner: DIFF_COMMENTS_OWNER };
			},
			setActiveCommentAndThread: async () => { },
		};

		this._commentService.registerCommentController(DIFF_COMMENTS_OWNER, controller);
		this._store.add({ dispose: () => this._commentService.unregisterCommentController(DIFF_COMMENTS_OWNER) });

		// Register delete action for our comment threads
		this._store.add(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'diffComments.deleteThread',
					title: localize('diffComments.delete', "Delete Comment"),
					icon: Codicon.trash,
					menu: {
						id: MenuId.CommentThreadTitle,
						when: ContextKeyExpr.equals('commentController', DIFF_COMMENTS_CONTEXT_VALUE),
						group: 'navigation',
					}
				});
			}
			run(accessor: ServicesAccessor, ...args: unknown[]): void {
				const diffCommentsService = accessor.get(IDiffCommentsService);
				const arg = args[0] as { thread?: { threadId?: string }; threadId?: string } | undefined;
				const thread = arg?.thread ?? arg;
				if (thread?.threadId) {
					const sessionResource = self._findSessionForComment(thread.threadId);
					if (sessionResource) {
						diffCommentsService.removeComment(sessionResource, thread.threadId);
					}
				}
			}
		}));
	}

	addComment(sessionResource: URI, resourceUri: URI, range: IRange, text: string): IDiffComment {
		this._ensureController();

		const key = sessionResource.toString();
		let comments = this._commentsBySession.get(key);
		if (!comments) {
			comments = [];
			this._commentsBySession.set(key, comments);
		}

		const comment: IDiffComment = {
			id: generateUuid(),
			text,
			resourceUri,
			range,
			sessionResource,
		};
		comments.push(comment);

		this._syncThreads(sessionResource);
		this._onDidChangeComments.fire({ sessionResource, comments });

		return comment;
	}

	removeComment(sessionResource: URI, commentId: string): void {
		const key = sessionResource.toString();
		const comments = this._commentsBySession.get(key);
		if (!comments) {
			return;
		}

		const idx = comments.findIndex(c => c.id === commentId);
		if (idx >= 0) {
			const removed = comments[idx];
			comments.splice(idx, 1);
			this._activeThreadIds.delete(commentId);

			// Fire updateComments with the thread in removed[] so the editor
			// controller's onDidUpdateCommentThreads handler removes the zone widget
			const thread = this._createThread(removed);
			thread.isDisposed = true;
			this._commentService.updateComments(DIFF_COMMENTS_OWNER, {
				added: [],
				removed: [thread],
				changed: [],
				pending: [],
			});

			this._onDidChangeComments.fire({ sessionResource, comments });
		}
	}

	/**
	 * Find which session a comment belongs to by its ID.
	 */
	_findSessionForComment(commentId: string): URI | undefined {
		for (const [, comments] of this._commentsBySession) {
			const comment = comments.find(c => c.id === commentId);
			if (comment) {
				return comment.sessionResource;
			}
		}
		return undefined;
	}

	getComments(sessionResource: URI): readonly IDiffComment[] {
		return this._commentsBySession.get(sessionResource.toString()) ?? [];
	}

	clearComments(sessionResource: URI): void {
		const key = sessionResource.toString();
		const comments = this._commentsBySession.get(key);
		if (comments && comments.length > 0) {
			const removedThreads = comments.map(c => {
				this._activeThreadIds.delete(c.id);
				const thread = this._createThread(c);
				thread.isDisposed = true;
				return thread;
			});

			this._commentService.updateComments(DIFF_COMMENTS_OWNER, {
				added: [],
				removed: removedThreads,
				changed: [],
				pending: [],
			});
		}
		this._commentsBySession.delete(key);
		this._onDidChangeComments.fire({ sessionResource, comments: [] });
	}

	/** Threads currently known to the comment service, keyed by comment id */
	private readonly _activeThreadIds = new Set<string>();

	/**
	 * Sync comment threads to the ICommentService using updateComments for
	 * incremental add/remove, which the editor controller listens to.
	 */
	private _syncThreads(_sessionResource: URI): void {
		// Collect all current comment IDs
		const currentIds = new Set<string>();
		const allComments: IDiffComment[] = [];
		for (const [, sessionComments] of this._commentsBySession) {
			for (const c of sessionComments) {
				currentIds.add(c.id);
				allComments.push(c);
			}
		}

		// Determine added and removed
		const added: CommentThread<IRange>[] = [];
		const removed: CommentThread<IRange>[] = [];

		for (const c of allComments) {
			if (!this._activeThreadIds.has(c.id)) {
				added.push(this._createThread(c));
			}
		}

		for (const id of this._activeThreadIds) {
			if (!currentIds.has(id)) {
				// Create a minimal thread just for removal (needs threadId and resource)
				removed.push(this._createRemovedThread(id));
			}
		}

		// Update tracking
		this._activeThreadIds.clear();
		for (const id of currentIds) {
			this._activeThreadIds.add(id);
		}

		if (added.length || removed.length) {
			this._commentService.updateComments(DIFF_COMMENTS_OWNER, {
				added,
				removed,
				changed: [],
				pending: [],
			});
		}
	}

	private _createRemovedThread(commentId: string): CommentThread<IRange> {
		const noopEvent = Event.None;
		return {
			isDocumentCommentThread(): this is CommentThread<IRange> { return true; },
			commentThreadHandle: -1,
			controllerHandle: 0,
			threadId: commentId,
			resource: null,
			range: undefined,
			label: undefined,
			contextValue: undefined,
			comments: undefined,
			onDidChangeComments: noopEvent,
			collapsibleState: CommentThreadCollapsibleState.Collapsed,
			initialCollapsibleState: CommentThreadCollapsibleState.Collapsed,
			onDidChangeInitialCollapsibleState: noopEvent,
			state: undefined,
			applicability: undefined,
			canReply: false,
			input: undefined,
			onDidChangeInput: noopEvent,
			onDidChangeLabel: noopEvent,
			onDidChangeCollapsibleState: noopEvent,
			onDidChangeState: noopEvent,
			onDidChangeCanReply: noopEvent,
			isDisposed: true,
			isTemplate: false,
		};
	}

	private _createThread(comment: IDiffComment): CommentThread<IRange> {
		const handle = this._nextThreadHandle++;

		const threadComment: Comment = {
			uniqueIdInThread: 1,
			body: comment.text,
			userName: 'You',
		};

		return new DiffCommentThread(handle, comment.id, comment.resourceUri.toString(), comment.range, [threadComment]);
	}
}

/**
 * A CommentThread implementation with proper emitters so the editor
 * comment controller can react to state changes (collapse/expand).
 */
class DiffCommentThread implements CommentThread<IRange> {

	private readonly _onDidChangeComments = new Emitter<readonly Comment[] | undefined>();
	readonly onDidChangeComments = this._onDidChangeComments.event;

	private readonly _onDidChangeCollapsibleState = new Emitter<CommentThreadCollapsibleState | undefined>();
	readonly onDidChangeCollapsibleState = this._onDidChangeCollapsibleState.event;

	private readonly _onDidChangeInitialCollapsibleState = new Emitter<CommentThreadCollapsibleState | undefined>();
	readonly onDidChangeInitialCollapsibleState = this._onDidChangeInitialCollapsibleState.event;

	private readonly _onDidChangeInput = new Emitter<CommentInput | undefined>();
	readonly onDidChangeInput = this._onDidChangeInput.event;

	private readonly _onDidChangeLabel = new Emitter<string | undefined>();
	readonly onDidChangeLabel = this._onDidChangeLabel.event;

	private readonly _onDidChangeState = new Emitter<CommentThreadState | undefined>();
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onDidChangeCanReply = new Emitter<boolean>();
	readonly onDidChangeCanReply = this._onDidChangeCanReply.event;

	readonly controllerHandle = 0;
	readonly label = undefined;
	readonly contextValue = undefined;
	readonly applicability = undefined;
	readonly input = undefined;
	readonly isTemplate = false;

	private _collapsibleState = CommentThreadCollapsibleState.Collapsed;
	get collapsibleState(): CommentThreadCollapsibleState { return this._collapsibleState; }
	set collapsibleState(value: CommentThreadCollapsibleState) {
		this._collapsibleState = value;
		this._onDidChangeCollapsibleState.fire(value);
	}

	readonly initialCollapsibleState = CommentThreadCollapsibleState.Collapsed;
	readonly state = CommentThreadState.Unresolved;
	readonly canReply = false;
	isDisposed = false;

	constructor(
		readonly commentThreadHandle: number,
		readonly threadId: string,
		readonly resource: string,
		readonly range: IRange,
		readonly comments: readonly Comment[],
	) { }

	isDocumentCommentThread(): this is CommentThread<IRange> {
		return true;
	}
}
