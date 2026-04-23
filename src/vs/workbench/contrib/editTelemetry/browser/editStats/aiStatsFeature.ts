/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TaskQueue, timeout } from '../../../../../base/common/async.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, observableValue } from '../../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IChatModel, IChatRequestModel } from '../../../chat/common/model/chatModel.js';
import { IChatService } from '../../../chat/common/chatService/chatService.js';
import { AiStatsStatusBar } from './aiStatsStatusBar.js';

export type AiStatsRange = 'all' | '30d' | '7d';

export interface IAiStatsOverview {
	readonly sessions: number;
	readonly messages: number;
	readonly totalTokens: number;
	readonly activeDays: number;
	readonly currentStreak: number;
	readonly longestStreak: number;
	/** Hour of day with the most requests (0-23), or undefined if no data. */
	readonly peakHour: number | undefined;
	/** Identifier of the most-used model in the range, or undefined if no data. */
	readonly favoriteModel: string | undefined;
	/** 7 rows (Sun..Sat) by 24 cols (hour of day) with request counts. */
	readonly heatmap: ReadonlyArray<ReadonlyArray<number>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface IDayBucket {
	requests: number;
	tokens: number;
	hourBuckets: number[]; // length 24
	modelCounts: { [modelId: string]: number };
}

interface IAiStatsData {
	/** Session ids we've already counted (capped). */
	seenSessions: string[];
	/** Day bucket keyed by yyyymmdd (local time). */
	days: { [day: string]: IDayBucket };
}

const MAX_DAYS_RETAINED = 30;
// Generous bound for distinct sessions seen within the retention window;
// sized so heavy users won't hit it before old day buckets age out.
const MAX_SEEN_SESSIONS = 2_000;

export class AiStatsFeature extends Disposable {

	private readonly _data: IValue<IAiStatsData>;
	private readonly _dataVersion = observableValue(this, 0);
	private readonly _recomputeTick = observableValue(this, 0);
	private readonly _seen = new Set<string>();

	readonly range = observableValue<AiStatsRange>(this, 'all');

	/**
	 * Bumps the {@link overview} derived so callers (e.g. the status bar hover)
	 * can force a recomputation, picking up things like a date rollover that
	 * does not produce a new chat request.
	 */
	triggerRecompute(): void {
		this._recomputeTick.set(this._recomputeTick.get() + 1, undefined);
	}

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IChatService private readonly _chatService: IChatService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		const storedValue = getStoredValue<IAiStatsData>(this._storageService, 'chatUsageStats', StorageScope.PROFILE, StorageTarget.USER);
		this._data = rateLimitWrite(storedValue, 1, this._store);

		const initial = this._data.getValue();
		if (initial?.seenSessions) {
			for (const id of initial.seenSessions) {
				this._seen.add(id);
			}
		}

		// Listen to all chat models, current and future
		this._register(autorun(reader => {
			const models = this._chatService.chatModels.read(reader);
			for (const model of models) {
				reader.store.add(this._observeModel(model));
			}
		}));

		// Status bar entry
		this._register(this._instantiationService.createInstance(AiStatsStatusBar, this));
	}

	private _observeModel(model: IChatModel): DisposableStore {
		const store = new DisposableStore();

		// Track tokens we've already added per request to avoid double counting
		const tokensAddedByRequestId = new Map<string, number>();

		// Process any requests already on the model when we attach
		for (const req of model.getRequests()) {
			this._recordRequest(req);
			const tokens = req.response?.completionTokenCount;
			if (typeof tokens === 'number' && tokens > 0) {
				tokensAddedByRequestId.set(req.id, tokens);
				this._recordTokens(req, tokens);
			}
		}

		store.add(model.onDidChange(e => {
			if (e.kind === 'addRequest') {
				this._recordRequest(e.request);
			} else if (e.kind === 'completedRequest' || e.kind === 'changedRequest') {
				const tokens = e.request.response?.completionTokenCount ?? 0;
				const previously = tokensAddedByRequestId.get(e.request.id) ?? 0;
				const delta = tokens - previously;
				if (delta > 0) {
					tokensAddedByRequestId.set(e.request.id, tokens);
					this._recordTokens(e.request, delta);
				}
			} else if (e.kind === 'removeRequest') {
				tokensAddedByRequestId.delete(e.requestId);
			}
		}));

		return store;
	}

	private _recordRequest(request: IChatRequestModel): void {
		const sessionId = request.session.sessionId;
		const isNewSession = !this._seen.has(sessionId);
		if (isNewSession) {
			this._seen.add(sessionId);
		}

		const data = this._getData();
		const ts = request.timestamp ?? Date.now();
		const date = new Date(ts);
		const bucket = this._getDayBucket(data, date);
		bucket.requests += 1;
		bucket.hourBuckets[date.getHours()] += 1;
		const modelId = request.modelId;
		if (modelId) {
			bucket.modelCounts[modelId] = (bucket.modelCounts[modelId] ?? 0) + 1;
		}
		if (isNewSession) {
			data.seenSessions.push(sessionId);
			if (data.seenSessions.length > MAX_SEEN_SESSIONS) {
				const removed = data.seenSessions.splice(0, data.seenSessions.length - MAX_SEEN_SESSIONS);
				for (const id of removed) {
					this._seen.delete(id);
				}
			}
		}
		this._persist(data);
	}

	private _recordTokens(request: IChatRequestModel, deltaTokens: number): void {
		const data = this._getData();
		const ts = request.timestamp ?? Date.now();
		const bucket = this._getDayBucket(data, new Date(ts));
		bucket.tokens += deltaTokens;
		this._persist(data);
	}

	private _getData(): IAiStatsData {
		return this._data.getValue() ?? { seenSessions: [], days: {} };
	}

	private _getDayBucket(data: IAiStatsData, date: Date): IDayBucket {
		const key = dayKey(date);
		let bucket = data.days[key];
		if (!bucket) {
			bucket = {
				requests: 0,
				tokens: 0,
				hourBuckets: new Array<number>(24).fill(0),
				modelCounts: {},
			};
			data.days[key] = bucket;
			// Trim oldest days
			const allKeys = Object.keys(data.days).sort();
			while (allKeys.length > MAX_DAYS_RETAINED) {
				const removed = allKeys.shift()!;
				delete data.days[removed];
			}
		}
		// Defensive: ensure shape after JSON round-trip
		if (!Array.isArray(bucket.hourBuckets) || bucket.hourBuckets.length !== 24) {
			const next = new Array<number>(24).fill(0);
			if (Array.isArray(bucket.hourBuckets)) {
				for (let i = 0; i < Math.min(24, bucket.hourBuckets.length); i++) {
					next[i] = bucket.hourBuckets[i] ?? 0;
				}
			}
			bucket.hourBuckets = next;
		}
		if (!bucket.modelCounts) {
			bucket.modelCounts = {};
		}
		return bucket;
	}

	private _persist(data: IAiStatsData): void {
		this._data.writeValue(data);
		this._dataVersion.set(this._dataVersion.get() + 1, undefined);
	}

	readonly overview: IObservable<IAiStatsOverview> = derived(this, reader => {
		this._dataVersion.read(reader);
		this._recomputeTick.read(reader);
		const range = this.range.read(reader);
		return computeOverview(this._getData(), this._seen.size, range, Date.now());
	});
}

function dayKey(date: Date): string {
	const y = date.getFullYear();
	const m = (date.getMonth() + 1).toString().padStart(2, '0');
	const d = date.getDate().toString().padStart(2, '0');
	return `${y}${m}${d}`;
}

function dayKeyFromTimestamp(ts: number): string {
	return dayKey(new Date(ts));
}

export function computeOverview(data: IAiStatsData, totalSessions: number, range: AiStatsRange, now: number): IAiStatsOverview {
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);

	let cutoff: number | undefined;
	if (range === '7d') {
		cutoff = startOfToday.getTime() - 6 * DAY_MS;
	} else if (range === '30d') {
		cutoff = startOfToday.getTime() - 29 * DAY_MS;
	}

	const allKeys = Object.keys(data.days).sort();
	const includedKeys = cutoff === undefined
		? allKeys
		: allKeys.filter(k => parseDayKey(k) >= cutoff!);

	let messages = 0;
	let tokens = 0;
	const hourTotals = new Array<number>(24).fill(0);
	const modelTotals = new Map<string, number>();
	const heatmap: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));

	for (const key of includedKeys) {
		const bucket = data.days[key];
		messages += bucket.requests;
		tokens += bucket.tokens;
		const dow = new Date(parseDayKey(key)).getDay();
		for (let h = 0; h < 24; h++) {
			const v = bucket.hourBuckets?.[h] ?? 0;
			hourTotals[h] += v;
			heatmap[dow][h] += v;
		}
		if (bucket.modelCounts) {
			for (const [m, c] of Object.entries(bucket.modelCounts)) {
				modelTotals.set(m, (modelTotals.get(m) ?? 0) + c);
			}
		}
	}

	const activeDays = includedKeys.filter(k => data.days[k].requests > 0).length;

	// Streaks computed within the included range
	const activeDaySet = new Set(includedKeys.filter(k => data.days[k].requests > 0));
	const { current, longest } = computeStreaks(activeDaySet, startOfToday.getTime(), cutoff);

	let peakHour: number | undefined;
	let peakHourValue = 0;
	for (let h = 0; h < 24; h++) {
		if (hourTotals[h] > peakHourValue) {
			peakHourValue = hourTotals[h];
			peakHour = h;
		}
	}

	let favoriteModel: string | undefined;
	let favoriteCount = 0;
	for (const [m, c] of modelTotals) {
		if (c > favoriteCount) {
			favoriteCount = c;
			favoriteModel = m;
		}
	}

	// Sessions is range-aware: count sessions whose first request was inside the range.
	// We don't store first-seen-time per session, so for 'all' we use the cap; for ranges,
	// approximate by summing distinct session days... fall back to total seen.
	// Simpler: for 'all', use totalSessions; for ranges, use min of totalSessions and messages.
	let sessions: number;
	if (range === 'all') {
		sessions = totalSessions;
	} else {
		// Approximation: a session has at least 1 message, so cap by messages.
		sessions = Math.min(totalSessions, messages);
	}

	return {
		sessions,
		messages,
		totalTokens: tokens,
		activeDays,
		currentStreak: current,
		longestStreak: longest,
		peakHour,
		favoriteModel,
		heatmap,
	};
}

function parseDayKey(key: string): number {
	const y = parseInt(key.substring(0, 4), 10);
	const m = parseInt(key.substring(4, 6), 10) - 1;
	const d = parseInt(key.substring(6, 8), 10);
	return new Date(y, m, d).getTime();
}

function computeStreaks(activeDays: ReadonlySet<string>, todayMs: number, cutoff: number | undefined): { current: number; longest: number } {
	// Current streak: consecutive trailing days ending today (or yesterday if today not active)
	let current = 0;
	let cursor = todayMs;
	// If today not active, start from yesterday
	if (!activeDays.has(dayKeyFromTimestamp(cursor))) {
		cursor -= DAY_MS;
	}
	while (activeDays.has(dayKeyFromTimestamp(cursor))) {
		if (cutoff !== undefined && cursor < cutoff) {
			break;
		}
		current++;
		cursor -= DAY_MS;
	}

	// Longest streak inside range
	const sortedKeys = Array.from(activeDays).sort();
	let longest = 0;
	let run = 0;
	let prevTs: number | undefined;
	for (const key of sortedKeys) {
		const ts = parseDayKey(key);
		if (prevTs !== undefined && ts - prevTs === DAY_MS) {
			run++;
		} else {
			run = 1;
		}
		if (run > longest) {
			longest = run;
		}
		prevTs = ts;
	}

	return { current, longest };
}

interface IValue<T> {
	writeValue(value: T | undefined): void;
	getValue(): T | undefined;
}

function rateLimitWrite<T>(targetValue: IValue<T>, maxWritesPerSecond: number, store: DisposableStore): IValue<T> {
	const queue = new TaskQueue();
	const minIntervalMs = 1000 / maxWritesPerSecond;
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
				await timeout(minIntervalMs);
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
			hasLastValue = true;
		},
		getValue(): T | undefined {
			if (hasLastValue) {
				return lastValue;
			}
			const strVal = service.get(key, scope);
			if (strVal === undefined) {
				lastValue = undefined;
			} else {
				try {
					lastValue = JSON.parse(strVal) as T | undefined;
				} catch {
					lastValue = undefined;
				}
			}
			hasLastValue = true;
			return lastValue;
		}
	};
}
