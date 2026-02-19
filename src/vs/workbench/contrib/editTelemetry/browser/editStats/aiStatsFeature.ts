/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sumBy } from '../../../../../base/common/arrays.js';
import { TaskQueue, timeout } from '../../../../../base/common/async.js';
import { Lazy } from '../../../../../base/common/lazy.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, autorunIterableDelta, derived, mapObservableArrayCached, observableValue, runOnChange } from '../../../../../base/common/observable.js';
import { AnnotatedStringEdit } from '../../../../../editor/common/core/edits/stringEdit.js';
import { isAiEdit, isUserEdit } from '../../../../../editor/common/textModelEditSource.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IChatService } from '../../../chat/common/chatService/chatService.js';
import { ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { IChatModel, IChatResponseModel } from '../../../chat/common/model/chatModel.js';
import { AnnotatedDocuments } from '../helpers/annotatedDocuments.js';
import { AiStatsStatusBar } from './aiStatsStatusBar.js';

export class AiStatsFeature extends Disposable {
	private readonly _data: IValue<IData>;
	private readonly _dataVersion = observableValue(this, 0);
	private readonly _trackedRequestIds = new Set<string>();

	constructor(
		annotatedDocuments: AnnotatedDocuments,
		@IStorageService private readonly _storageService: IStorageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IChatService private readonly _chatService: IChatService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
	) {
		super();

		const storedValue = getStoredValue<IData>(this._storageService, 'aiStats', StorageScope.WORKSPACE, StorageTarget.USER);
		this._data = rateLimitWrite<IData>(storedValue, 1 / 60, this._store);

		this.aiRate.recomputeInitiallyAndOnChange(this._store);

		this._register(autorun(reader => {
			reader.store.add(this._instantiationService.createInstance(AiStatsStatusBar.hot.read(reader), this));
		}));

		this._trackChatRequests();


		const lastRequestIds: string[] = [];

		const obs = mapObservableArrayCached(this, annotatedDocuments.documents, (doc, store) => {
			store.add(runOnChange(doc.documentWithAnnotations.value, (_val, _prev, edit) => {
				const e = AnnotatedStringEdit.compose(edit.map(e => e.edit));

				const curSession = new Lazy(() => this._getDataAndSession());

				for (const r of e.replacements) {
					if (isAiEdit(r.data.editSource)) {
						curSession.value.currentSession.aiCharacters += r.newText.length;
					} else if (isUserEdit(r.data.editSource)) {
						curSession.value.currentSession.typedCharacters += r.newText.length;
					}
				}

				if (e.replacements.length > 0) {
					const sessionToUpdate = curSession.value.currentSession;
					const s = e.replacements[0].data.editSource;
					if (s.metadata.source === 'inlineCompletionAccept') {
						if (sessionToUpdate.acceptedInlineSuggestions === undefined) {
							sessionToUpdate.acceptedInlineSuggestions = 0;
						}
						sessionToUpdate.acceptedInlineSuggestions += 1;
					}

					if (s.metadata.source === 'Chat.applyEdits' && s.metadata.$$requestId !== undefined) {
						const didSeeRequestId = lastRequestIds.includes(s.metadata.$$requestId);
						if (!didSeeRequestId) {
							lastRequestIds.push(s.metadata.$$requestId);
							if (lastRequestIds.length > 10) {
								lastRequestIds.shift();
							}
							if (sessionToUpdate.chatEditCount === undefined) {
								sessionToUpdate.chatEditCount = 0;
							}
							sessionToUpdate.chatEditCount += 1;
						}
					}
				}

				if (curSession.hasValue) {
					this._data.writeValue(curSession.value.data);
					this._dataVersion.set(this._dataVersion.get() + 1, undefined);
				}
			}));
		});

		obs.recomputeInitiallyAndOnChange(this._store);
	}

	public readonly aiRate = this._dataVersion.map(() => {
		const val = this._data.getValue();
		if (!val) {
			return 0;
		}

		const r = average(val.sessions, session => {
			const sum = session.typedCharacters + session.aiCharacters;
			if (sum === 0) {
				return 0;
			}
			return session.aiCharacters / sum;
		});

		return r;
	});

	public readonly sessionCount = derived(this, r => {
		this._dataVersion.read(r);
		const val = this._data.getValue();
		if (!val) {
			return 0;
		}
		return val.sessions.length;
	});

	public readonly sessions = derived(this, r => {
		this._dataVersion.read(r);
		const val = this._data.getValue();
		if (!val) {
			return [];
		}
		return val.sessions;
	});

	public readonly acceptedInlineSuggestionsToday = derived(this, r => {
		this._dataVersion.read(r);
		const val = this._data.getValue();
		if (!val) {
			return 0;
		}
		const startOfToday = new Date();
		startOfToday.setHours(0, 0, 0, 0);

		const sessionsToday = val.sessions.filter(s => s.startTime > startOfToday.getTime());
		return sumBy(sessionsToday, s => s.acceptedInlineSuggestions ?? 0);
	});

	public readonly chatRequests = derived(this, r => {
		this._dataVersion.read(r);
		const val = this._data.getValue();
		return val?.chatRequests ?? [];
	});

	public readonly chatSessionCount = derived(this, r => {
		const requests = this.chatRequests.read(r);
		const uniqueSessions = new Set(requests.map(req => req.sessionId));
		return uniqueSessions.size;
	});

	public readonly totalTokenUsage = derived(this, r => {
		const requests = this.chatRequests.read(r);
		const input = sumBy(requests, req => req.promptTokens);
		const output = sumBy(requests, req => req.completionTokens);
		return { total: input + output, input, output };
	});

	public readonly requestsByDayOfWeek = derived(this, r => {
		const requests = this.chatRequests.read(r);
		const counts: number[] = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat
		for (const req of requests) {
			const day = new Date(req.timestamp).getDay();
			counts[day]++;
		}
		return counts;
	});

	public readonly requestsByHourOfDay = derived(this, r => {
		const requests = this.chatRequests.read(r);
		const counts: number[] = new Array(24).fill(0);
		for (const req of requests) {
			const hour = new Date(req.timestamp).getHours();
			counts[hour]++;
		}
		return counts;
	});

	public readonly topModels = derived(this, r => {
		const requests = this.chatRequests.read(r);
		const modelCounts = new Map<string, number>();
		for (const req of requests) {
			const model = req.modelId;
			if (!model) {
				continue;
			}
			modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
		}
		return [...modelCounts.entries()]
			.map(([modelId, count]) => {
				const metadata = this._languageModelsService.lookupLanguageModel(modelId);
				const displayName = metadata?.name || modelId;
				return { modelId: displayName, count };
			})
			.sort((a, b) => b.count - a.count);
	});

	private _trackChatRequests(): void {
		const modelTrackers = this._register(new DisposableMap<string>());

		this._register(autorunIterableDelta(
			reader => this._chatService.chatModels.read(reader),
			({ addedValues, removedValues }) => {
				for (const model of addedValues) {
					modelTrackers.set(model.sessionId, this._trackChatModel(model));
				}
				for (const model of removedValues) {
					modelTrackers.deleteAndDispose(model.sessionId);
				}
			}
		));
	}

	private _trackChatModel(model: IChatModel): DisposableStore {
		const store = new DisposableStore();

		// Record any already-completed requests
		for (const request of model.getRequests()) {
			if (request.response?.isComplete) {
				this._recordChatRequest(request.response, model.sessionId);
			}
		}

		// Listen for new completed requests
		store.add(model.onDidChange(e => {
			if (e.kind === 'completedRequest') {
				const response = e.request.response;
				if (response?.isComplete) {
					this._recordChatRequest(response, model.sessionId);
				}
			}
		}));

		return store;
	}

	private _recordChatRequest(response: IChatResponseModel, sessionId: string): void {
		const request = response.request;
		if (!request) {
			return;
		}

		const requestId = request.id;
		if (this._trackedRequestIds.has(requestId)) {
			return;
		}
		this._trackedRequestIds.add(requestId);

		const record: IChatRequestRecord = {
			timestamp: request.timestamp,
			modelId: request.modelId ?? '',
			promptTokens: response.usage?.promptTokens ?? 0,
			completionTokens: response.usage?.completionTokens ?? 0,
			sessionId,
			requestId,
		};

		const state = this._data.getValue() ?? { sessions: [] };
		if (!state.chatRequests) {
			state.chatRequests = [];
		}

		// Deduplicate
		if (state.chatRequests.some(r => r.requestId === requestId)) {
			return;
		}

		state.chatRequests.push(record);

		// Clean up old records (keep last 7 days)
		const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
		state.chatRequests = state.chatRequests.filter(r => r.timestamp > sevenDaysAgo);

		this._data.writeValue(state);
		this._dataVersion.set(this._dataVersion.get() + 1, undefined);
	}

	private _getDataAndSession(): { data: IData; currentSession: ISession } {
		const state = this._data.getValue() ?? { sessions: [] };

		const sessionLengthMs = 5 * 60 * 1000; // 5 minutes

		let lastSession = state.sessions.at(-1);
		const nowTime = Date.now();
		if (!lastSession || nowTime - lastSession.startTime > sessionLengthMs) {
			state.sessions.push({
				startTime: nowTime,
				typedCharacters: 0,
				aiCharacters: 0,
				acceptedInlineSuggestions: 0,
				chatEditCount: 0,
			});
			lastSession = state.sessions.at(-1)!;

			const dayMs = 24 * 60 * 60 * 1000; // 24h
			// Clean up old sessions, keep only the last 24h worth of sessions
			while (state.sessions.length > dayMs / sessionLengthMs) {
				state.sessions.shift();
			}
		}
		return { data: state, currentSession: lastSession };
	}
}

interface IData {
	sessions: ISession[];
	chatRequests?: IChatRequestRecord[];
}

// 5 min window
interface ISession {
	startTime: number;
	typedCharacters: number;
	aiCharacters: number;
	acceptedInlineSuggestions: number | undefined;
	chatEditCount: number | undefined;
}

export interface IChatRequestRecord {
	timestamp: number;
	modelId: string;
	promptTokens: number;
	completionTokens: number;
	sessionId: string;
	requestId: string;
}


function average<T>(arr: T[], selector: (item: T) => number): number {
	if (arr.length === 0) {
		return 0;
	}
	const s = sumBy(arr, selector);
	return s / arr.length;
}


interface IValue<T> {
	writeValue(value: T | undefined): void;
	getValue(): T | undefined;
}

function rateLimitWrite<T>(targetValue: IValue<T>, maxWritesPerSecond: number, store: DisposableStore): IValue<T> {
	const queue = new TaskQueue();
	let _value: T | undefined = undefined;
	let valueVersion = 0;
	let savedVersion = 0;
	store.add(toDisposable(() => {
		if (valueVersion !== savedVersion) {
			targetValue.writeValue(_value);
			savedVersion = valueVersion;
		}
	}));

	return {
		writeValue(value: T | undefined): void {
			valueVersion++;
			const v = valueVersion;
			_value = value;

			queue.clearPending();
			queue.schedule(async () => {
				targetValue.writeValue(value);
				savedVersion = v;
				await timeout(5000);
			});
		},
		getValue(): T | undefined {
			if (valueVersion > 0) {
				return _value;
			}
			return targetValue.getValue();
		}
	};
}

function getStoredValue<T>(service: IStorageService, key: string, scope: StorageScope, target: StorageTarget): IValue<T> {
	let lastValue: T | undefined = undefined;
	let hasLastValue = false;
	return {
		writeValue(value: T | undefined): void {
			if (value === undefined) {
				service.remove(key, scope);
			} else {
				service.store(key, JSON.stringify(value), scope, target);
			}
			lastValue = value;
		},
		getValue(): T | undefined {
			if (hasLastValue) {
				return lastValue;
			}
			const strVal = service.get(key, scope);
			lastValue = strVal === undefined ? undefined : JSON.parse(strVal) as T | undefined;
			hasLastValue = true;
			return lastValue;
		}
	};
}
