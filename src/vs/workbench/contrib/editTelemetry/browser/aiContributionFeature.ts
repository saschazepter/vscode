/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { autorun, mapObservableArrayCached, runOnChange } from '../../../../base/common/observable.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { StringReplacement } from '../../../../editor/common/core/edits/stringEdit.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { EditSourceBase } from './helpers/documentWithAnnotatedEdits.js';
import { ObservableWorkspace } from './helpers/observableWorkspace.js';

export type AiContributionLevel = 'chatAndAgent' | 'all';

const STORAGE_KEY = 'aiEdits.contributions';
const SAVE_DEBOUNCE_MS = 250;

/**
 * Tracks which URIs contain *surviving* AI-generated content for git co-author
 * trailer attribution.
 *
 * Unlike a simple "AI ever touched this URI" flag, this tracker shrinks the
 * recorded AI ranges as edits replace, delete, or split them, and removes the
 * URI entirely once no AI-authored content remains. That way users who revert
 * an AI suggestion before committing do not get a misleading
 * `Co-authored-by: Copilot` trailer.
 *
 * State is persisted per workspace, keyed by URI, together with the document
 * length at the time of snapshot. On window reload, persisted state is only
 * restored for documents whose current length still matches; otherwise the
 * entry is dropped (we cannot meaningfully rebase ranges across an offline
 * change).
 */
export class AiContributionFeature extends Disposable {

	/** In-memory tracker for currently-loaded documents. */
	private readonly _live = new ResourceMap<AiSurvivingRanges>();

	/**
	 * Persisted snapshots for URIs that are not currently loaded (or that
	 * still match their loaded content). Used to answer queries for
	 * commits made on closed files and to seed live trackers on document
	 * load.
	 */
	private readonly _persisted = new ResourceMap<IPersistedRangesEntry>();

	private readonly _saveScheduler: RunOnceScheduler;
	private _dirty = false;
	private _disposing = false;

	constructor(
		workspace: ObservableWorkspace,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();

		this._loadFromStorage();

		this._saveScheduler = this._register(new RunOnceScheduler(() => this._saveToStorage(), SAVE_DEBOUNCE_MS));
		this._register(this._storageService.onWillSaveState(() => {
			if (this._dirty) {
				this._saveScheduler.cancel();
				this._saveToStorage();
			}
		}));

		// Subscribe to every loaded document. We deliberately do NOT gate on editor
		// visibility, because the trailer should still be added when the agent edits
		// a file that the user never opens, and it should survive closing the file.
		const trackedDocs = mapObservableArrayCached(this, workspace.documents, (doc, store) => {
			const initialLength = doc.value.get().value.length;
			const persisted = this._persisted.get(doc.uri);
			let ranges: AiSurvivingRanges;
			if (persisted && persisted.contentLength === initialLength) {
				ranges = AiSurvivingRanges.fromSerialized(persisted.ranges);
			} else {
				if (persisted) {
					// Document content changed between sessions; we cannot rebase
					// AI ranges across an offline edit, so drop the stale entry.
					this._persisted.delete(doc.uri);
					this._markDirty();
				}
				ranges = new AiSurvivingRanges();
			}
			this._live.set(doc.uri, ranges);

			store.add(runOnChange(doc.value, (_val, _prev, edits) => {
				let changed = false;
				for (const e of edits) {
					const source = EditSourceBase.create(e.reason);
					const level: AiContributionLevel | undefined = source.category === 'ai'
						? (source.feature === 'chat' ? 'chatAndAgent' : 'all')
						: undefined;
					if (ranges.apply(e.replacements, level)) {
						changed = true;
					}
				}
				if (changed) {
					this._snapshot(doc.uri, ranges, doc.value.get().value.length);
				}
			}));

			store.add(toDisposable(() => {
				// Snapshot one last time when the document leaves the workspace
				// so closed files keep their attribution across reloads.
				this._snapshot(doc.uri, ranges, doc.value.get().value.length);
				this._live.delete(doc.uri);
			}));
		});

		// Force the cached array to be evaluated so the per-document subscriptions are wired up.
		this._register(autorun(reader => { trackedDocs.read(reader); }));

		this._register(CommandsRegistry.registerCommand('_aiEdits.hasAiContributions',
			(_acc, resources: UriComponents[], level: AiContributionLevel) => this._hasAiContributions(resources, level)));
		this._register(CommandsRegistry.registerCommand('_aiEdits.clearAiContributions',
			(_acc, resources: UriComponents[]) => this._clearAiContributions(resources)));
		this._register(CommandsRegistry.registerCommand('_aiEdits.clearAllAiContributions',
			() => this._clearAiContributions()));
	}

	public override dispose(): void {
		// Cancel the debounced save first, then run super.dispose() which, via the
		// per-document `toDisposable` callbacks, takes one final snapshot of every
		// live document. Only after those snapshots have updated `_persisted` do
		// we flush to storage. Flushing before super.dispose() would lose the
		// final snapshots, because the scheduler they try to schedule has just
		// been disposed along with the rest of this feature.
		this._disposing = true;
		this._saveScheduler.cancel();
		super.dispose();
		if (this._dirty) {
			this._saveToStorage();
		}
	}

	private _snapshot(uri: URI, ranges: AiSurvivingRanges, contentLength: number): void {
		if (ranges.isEmpty()) {
			if (this._persisted.delete(uri)) {
				this._markDirty();
			}
			return;
		}
		this._persisted.set(uri, { contentLength, ranges: ranges.serialize() });
		this._markDirty();
	}

	private _markDirty(): void {
		this._dirty = true;
		if (!this._disposing) {
			this._saveScheduler.schedule();
		}
	}

	private _hasAiContributions(resources: UriComponents[], level: AiContributionLevel): boolean {
		for (const r of resources) {
			const uri = URI.revive(r);
			const live = this._live.get(uri);
			if (live) {
				if (live.hasLevel(level)) {
					return true;
				}
				continue;
			}
			const persisted = this._persisted.get(uri);
			if (persisted && hasLevel(persisted.ranges, level)) {
				return true;
			}
		}
		return false;
	}

	private _clearAiContributions(resources?: UriComponents[]): void {
		let changed = false;
		if (!resources) {
			if (this._persisted.size > 0) {
				this._persisted.clear();
				changed = true;
			}
			for (const ranges of this._live.values()) {
				if (!ranges.isEmpty()) {
					ranges.clear();
					changed = true;
				}
			}
		} else {
			for (const r of resources) {
				const uri = URI.revive(r);
				if (this._persisted.delete(uri)) {
					changed = true;
				}
				const live = this._live.get(uri);
				if (live && !live.isEmpty()) {
					live.clear();
					changed = true;
				}
			}
		}
		if (changed) {
			this._markDirty();
		}
	}

	private _loadFromStorage(): void {
		const raw = this._storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return;
		}
		for (const [uriString, value] of Object.entries(parsed as Record<string, unknown>)) {
			const entry = parsePersistedEntry(value);
			if (!entry) {
				continue;
			}
			let uri: URI;
			try {
				uri = URI.parse(uriString);
			} catch {
				continue;
			}
			this._persisted.set(uri, entry);
		}
	}

	private _saveToStorage(): void {
		// Only clear the dirty flag after a successful write, so that if the
		// storage call throws the onWillSaveState / dispose paths still see
		// pending state and can retry.
		try {
			if (this._persisted.size === 0) {
				this._storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
			} else {
				const obj: Record<string, IPersistedRangesEntry> = {};
				for (const [uri, entry] of this._persisted) {
					obj[uri.toString()] = entry;
				}
				// StorageTarget.MACHINE: do not sync via Settings Sync. AI range
				// offsets are tied to on-disk document content, which differs
				// per machine, so syncing would produce stale attributions.
				this._storageService.store(STORAGE_KEY, JSON.stringify(obj), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
			this._dirty = false;
		} catch {
			// Keep _dirty true so a later save attempt can retry.
		}
	}
}

interface ISerializedRange {
	readonly start: number;
	readonly length: number;
	readonly level: AiContributionLevel;
}

interface IPersistedRangesEntry {
	readonly contentLength: number;
	readonly ranges: readonly ISerializedRange[];
}

function hasLevel(ranges: readonly ISerializedRange[], level: AiContributionLevel): boolean {
	if (ranges.length === 0) {
		return false;
	}
	if (level === 'all') {
		return true;
	}
	for (const r of ranges) {
		if (r.level === 'chatAndAgent') {
			return true;
		}
	}
	return false;
}

function parsePersistedEntry(value: unknown): IPersistedRangesEntry | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const v = value as { contentLength?: unknown; ranges?: unknown };
	if (typeof v.contentLength !== 'number' || !Number.isFinite(v.contentLength) || v.contentLength < 0) {
		return undefined;
	}
	if (!Array.isArray(v.ranges)) {
		return undefined;
	}
	const ranges: ISerializedRange[] = [];
	for (const r of v.ranges) {
		if (!r || typeof r !== 'object') {
			continue;
		}
		const { start, length, level } = r as { start?: unknown; length?: unknown; level?: unknown };
		if (typeof start !== 'number' || typeof length !== 'number' || length <= 0 || start < 0) {
			continue;
		}
		if (level !== 'all' && level !== 'chatAndAgent') {
			continue;
		}
		if (start + length > v.contentLength) {
			continue;
		}
		ranges.push({ start, length, level });
	}
	if (ranges.length === 0) {
		return undefined;
	}
	ranges.sort((a, b) => a.start - b.start);
	return { contentLength: v.contentLength, ranges: mergeTouching(ranges) };
}

/**
 * Maintains a sorted, non-overlapping list of AI-authored offset ranges and
 * keeps them in sync with arbitrary text edits.
 */
class AiSurvivingRanges {

	public static fromSerialized(ranges: readonly ISerializedRange[]): AiSurvivingRanges {
		const copy = ranges.map(r => ({ start: r.start, length: r.length, level: r.level }));
		copy.sort((a, b) => a.start - b.start);
		return new AiSurvivingRanges(mergeTouching(copy));
	}

	private _ranges: ISerializedRange[];

	constructor(ranges: ISerializedRange[] = []) {
		this._ranges = ranges;
	}

	public isEmpty(): boolean {
		return this._ranges.length === 0;
	}

	public hasLevel(level: AiContributionLevel): boolean {
		return hasLevel(this._ranges, level);
	}

	public clear(): void {
		this._ranges = [];
	}

	public serialize(): ISerializedRange[] {
		return this._ranges.map(r => ({ start: r.start, length: r.length, level: r.level }));
	}

	/**
	 * Apply a batch of replacements (in coordinates of the document state
	 * before the batch). Returns `true` iff the surviving ranges changed.
	 *
	 * @param level if defined, the inserted text is recorded as AI-authored
	 *              at the given level; otherwise the edit is treated as
	 *              non-AI (it can still trim or split existing AI ranges).
	 */
	public apply(replacements: readonly StringReplacement[], level: AiContributionLevel | undefined): boolean {
		if (replacements.length === 0) {
			return false;
		}
		// Process in reverse order so that each replacement's "before" coordinates
		// remain valid against the (still-unmodified) lower part of the document.
		let changed = false;
		for (let i = replacements.length - 1; i >= 0; i--) {
			const r = replacements[i];
			if (this._applyOne(r.replaceRange.start, r.replaceRange.endExclusive, r.newText.length, level)) {
				changed = true;
			}
		}
		return changed;
	}

	private _applyOne(start: number, endExclusive: number, newLen: number, level: AiContributionLevel | undefined): boolean {
		const delta = newLen - (endExclusive - start);
		const out: ISerializedRange[] = [];
		let touched = false;

		for (const r of this._ranges) {
			const rEnd = r.start + r.length;
			if (rEnd <= start) {
				// Entirely before the edit - unaffected.
				out.push(r);
			} else if (r.start >= endExclusive) {
				// Entirely after the edit - shifted by delta.
				if (delta !== 0) {
					out.push({ start: r.start + delta, length: r.length, level: r.level });
					touched = true;
				} else {
					out.push(r);
				}
			} else {
				// Overlaps the deleted range. Keep the parts outside it.
				touched = true;
				if (r.start < start) {
					out.push({ start: r.start, length: start - r.start, level: r.level });
				}
				if (rEnd > endExclusive) {
					out.push({ start: endExclusive + delta, length: rEnd - endExclusive, level: r.level });
				}
			}
		}

		if (level !== undefined && newLen > 0) {
			insertSorted(out, { start, length: newLen, level });
			touched = true;
		}

		if (!touched) {
			return false;
		}
		this._ranges = mergeTouching(out);
		return true;
	}
}

function insertSorted(list: ISerializedRange[], r: ISerializedRange): void {
	let i = 0;
	while (i < list.length && list[i].start < r.start) {
		i++;
	}
	list.splice(i, 0, r);
}

function mergeTouching(ranges: ISerializedRange[]): ISerializedRange[] {
	if (ranges.length <= 1) {
		return ranges;
	}
	const out: ISerializedRange[] = [];
	let cur: ISerializedRange = ranges[0];
	for (let i = 1; i < ranges.length; i++) {
		const next = ranges[i];
		const curEnd = cur.start + cur.length;
		if (next.start <= curEnd && next.level === cur.level) {
			const end = Math.max(curEnd, next.start + next.length);
			cur = { start: cur.start, length: end - cur.start, level: cur.level };
		} else {
			out.push(cur);
			cur = next;
		}
	}
	out.push(cur);
	return out;
}
