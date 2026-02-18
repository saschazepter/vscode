/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { safeIntl } from '../../../../../base/common/date.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { language } from '../../../../../base/common/platform.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { ChatViewPaneTarget, IChatWidgetService } from '../chat.js';
import { IChatSessionEmbeddingsService, IChatSessionSearchResult } from '../../common/chatSessionEmbeddingsService.js';
import { CHAT_CATEGORY } from './chatActions.js';

interface IConversationSearchPickItem extends IQuickPickItem {
	readonly result: IChatSessionSearchResult;
}

export function registerChatSessionSearchActions() {
	registerAction2(class SearchConversationsAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.searchConversations',
				title: localize2('chat.searchConversations', "Search Past Conversations"),
				category: CHAT_CATEGORY,
				icon: Codicon.search,
				f1: true,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const quickInputService = accessor.get(IQuickInputService);
			const embeddingsService = accessor.get(IChatSessionEmbeddingsService);
			const chatWidgetService = accessor.get(IChatWidgetService);

			const disposables = new DisposableStore();
			const picker = disposables.add(quickInputService.createQuickPick<IConversationSearchPickItem>({ useSeparators: true }));
			picker.placeholder = localize('chat.searchConversations.placeholder', "Search past coding agent conversations...");
			picker.matchOnDescription = true;
			picker.matchOnDetail = true;
			picker.busy = !embeddingsService.isReady;

			// Wait for index to be ready
			if (!embeddingsService.isReady) {
				disposables.add(embeddingsService.onDidUpdateIndex(() => {
					picker.busy = false;
				}));
			}

			let searchDebounce: ReturnType<typeof setTimeout> | undefined;
			let currentCts: CancellationTokenSource | undefined;

			disposables.add(picker.onDidChangeValue(value => {
				if (searchDebounce) {
					clearTimeout(searchDebounce);
				}
				if (currentCts) {
					currentCts.cancel();
					currentCts.dispose();
				}

				if (!value.trim()) {
					picker.items = [];
					return;
				}

				picker.busy = true;
				currentCts = new CancellationTokenSource();
				const token = currentCts.token;

				searchDebounce = setTimeout(async () => {
					try {
						const results = await embeddingsService.search(value, 20, token);
						if (token.isCancellationRequested) {
							return;
						}

						const dateFormatter = safeIntl.DateTimeFormat(language, {
							year: 'numeric', month: 'short', day: 'numeric',
							hour: '2-digit', minute: '2-digit'
						});

						picker.items = results.map(result => {
							const date = dateFormatter.value.format(new Date(result.lastMessageDate));
							const scorePercent = Math.round(result.score * 100);
							return {
								label: `$(comment-discussion) ${result.title}`,
								description: `${date} - ${scorePercent}% match`,
								detail: result.matchSnippet.substring(0, 150),
								result,
							};
						});
					} catch {
						// search cancelled or failed
					} finally {
						if (!token.isCancellationRequested) {
							picker.busy = false;
						}
					}
				}, 300);
			}));

			disposables.add(picker.onDidAccept(async () => {
				const selected = picker.selectedItems[0];
				if (selected) {
					picker.hide();
					await chatWidgetService.openSession(selected.result.sessionResource, ChatViewPaneTarget);
				}
			}));

			disposables.add(picker.onDidHide(() => {
				if (searchDebounce) {
					clearTimeout(searchDebounce);
				}
				if (currentCts) {
					currentCts.cancel();
					currentCts.dispose();
				}
				disposables.dispose();
			}));

			picker.show();
		}
	});

	registerAction2(class RebuildConversationIndexAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.rebuildConversationIndex',
				title: localize2('chat.rebuildIndex', "Rebuild Conversation Search Index"),
				category: CHAT_CATEGORY,
				f1: true,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const embeddingsService = accessor.get(IChatSessionEmbeddingsService);
			await embeddingsService.rebuildIndex();
		}
	});
}
