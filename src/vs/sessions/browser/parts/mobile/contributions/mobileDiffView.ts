/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/mobileOverlayViews.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Gesture, EventType as TouchEventType } from '../../../../../base/browser/touch.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { URI } from '../../../../../base/common/uri.js';
import { basename } from '../../../../../base/common/resources.js';

const $ = DOM.$;

type DiffTab = 'diff' | 'file';

/**
 * Minimal subset of diff entry fields consumed by the mobile diff view.
 * Defined locally to avoid importing from vs/workbench/contrib in vs/sessions/browser.
 */
export interface IFileDiffViewData {
	readonly originalURI: URI;
	readonly modifiedURI: URI;
	readonly identical: boolean;
	readonly added: number;
	readonly removed: number;
}

/**
 * Data passed to {@link MobileDiffView} when opening a diff view.
 */
export interface IMobileDiffViewData {
	readonly diff: IFileDiffViewData;
}

/**
 * Full-screen overlay for viewing file changes produced by a coding agent session
 * on phone viewports.
 *
 * The view provides two tabs:
 * - **Diff** — a unified diff with coloured +/- gutters and line numbers.
 * - **File** — the full modified file content with changed lines highlighted.
 *
 * Text is read from the file service via the modified/original URIs stored in
 * {@link IFileDiffViewData}.  This keeps the view lightweight — it avoids
 * embedding a full Monaco diff editor while still giving users a readable view
 * of what changed.
 *
 * Follows the account-sheet overlay pattern: appends to the workbench container,
 * disposes on back-button tap.
 */
export class MobileDiffView extends Disposable {

	private readonly viewStore = this._register(new DisposableStore());
	private activeTab: DiffTab = 'diff';

	constructor(
		workbenchContainer: HTMLElement,
		data: IMobileDiffViewData,
		private readonly textFileService: ITextFileService,
	) {
		super();
		this.render(workbenchContainer, data);
	}

	private render(workbenchContainer: HTMLElement, data: IMobileDiffViewData): void {
		const { diff } = data;
		const fileName = basename(diff.modifiedURI);

		// -- Root overlay -----------------------------------------
		const overlay = DOM.append(workbenchContainer, $('div.mobile-overlay-view'));
		this.viewStore.add(DOM.addDisposableListener(overlay, DOM.EventType.CONTEXT_MENU, e => e.preventDefault()));
		this.viewStore.add(toDisposable(() => overlay.remove()));

		// -- Header -----------------------------------------------
		const header = DOM.append(overlay, $('div.mobile-overlay-header'));

		const backBtn = DOM.append(header, $('button.mobile-overlay-back-btn', { type: 'button' })) as HTMLButtonElement;
		backBtn.setAttribute('aria-label', localize('diffView.back', "Back"));
		DOM.append(backBtn, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronLeft));
		DOM.append(backBtn, $('span.back-btn-label')).textContent = localize('diffView.backLabel', "Back");
		this.viewStore.add(Gesture.addTarget(backBtn));
		this.viewStore.add(DOM.addDisposableListener(backBtn, DOM.EventType.CLICK, () => this.dispose()));
		this.viewStore.add(DOM.addDisposableListener(backBtn, TouchEventType.Tap, () => this.dispose()));

		const info = DOM.append(header, $('div.mobile-overlay-header-info'));
		DOM.append(info, $('div.mobile-overlay-header-title')).textContent = fileName;

		if (!diff.identical) {
			const sub = DOM.append(info, $('div.mobile-overlay-header-subtitle'));
			const parts: string[] = [];
			if (diff.added) {
				parts.push(`+${diff.added}`);
			}
			if (diff.removed) {
				parts.push(`-${diff.removed}`);
			}
			sub.textContent = parts.join('  ');
		}

		// -- Segmented control -------------------------------------
		const segBar = DOM.append(overlay, $('div.mobile-overlay-segment-bar'));
		const diffBtn = DOM.append(segBar, $('button.mobile-overlay-segment', { type: 'button' })) as HTMLButtonElement;
		diffBtn.textContent = localize('diffView.tabDiff', "Diff");
		const fileBtn = DOM.append(segBar, $('button.mobile-overlay-segment', { type: 'button' })) as HTMLButtonElement;
		fileBtn.textContent = localize('diffView.tabFile', "File");

		// -- Body -------------------------------------------------
		const body = DOM.append(overlay, $('div.mobile-overlay-body'));
		const scrollWrapper = DOM.append(body, $('div.mobile-overlay-scroll'));
		const contentArea = DOM.append(scrollWrapper, $('div.mobile-diff-output'));

		// Segment switching logic
		const switchTab = (tab: DiffTab) => {
			this.activeTab = tab;
			diffBtn.classList.toggle('active', tab === 'diff');
			fileBtn.classList.toggle('active', tab === 'file');
			this.loadContent(contentArea, diff, tab);
		};

		this.viewStore.add(Gesture.addTarget(diffBtn));
		this.viewStore.add(DOM.addDisposableListener(diffBtn, DOM.EventType.CLICK, () => switchTab('diff')));
		this.viewStore.add(DOM.addDisposableListener(diffBtn, TouchEventType.Tap, () => switchTab('diff')));
		this.viewStore.add(Gesture.addTarget(fileBtn));
		this.viewStore.add(DOM.addDisposableListener(fileBtn, DOM.EventType.CLICK, () => switchTab('file')));
		this.viewStore.add(DOM.addDisposableListener(fileBtn, TouchEventType.Tap, () => switchTab('file')));

		// Initial render
		switchTab('diff');
	}

	private loadContent(container: HTMLElement, diff: IFileDiffViewData, tab: DiffTab): void {
		DOM.clearNode(container);

		if (diff.identical) {
			const empty = DOM.append(container, $('div.mobile-diff-empty-state'));
			empty.textContent = localize('diffView.noChanges', "No changes in this file.");
			return;
		}

		if (tab === 'file') {
			this.loadFileContent(container, diff);
		} else {
			this.loadDiffContent(container, diff);
		}
	}

	private loadFileContent(container: HTMLElement, diff: IFileDiffViewData): void {
		const loadingEl = DOM.append(container, $('div.mobile-diff-empty-state'));
		loadingEl.textContent = localize('diffView.loading', "Loading…");

		this.textFileService.read(diff.modifiedURI, { acceptTextOnly: true }).then(model => {
			if (this.activeTab !== 'file') {
				return; // navigated away
			}
			DOM.clearNode(container);
			const lines = model.value.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const row = DOM.append(container, $('div.mobile-diff-line'));
				const numEl = DOM.append(row, $('span.mobile-diff-line-num'));
				numEl.textContent = String(i + 1);
				const content = DOM.append(row, $('span.mobile-diff-content'));
				content.textContent = lines[i];
			}
		}).catch(() => {
			if (this.activeTab !== 'file') {
				return;
			}
			DOM.clearNode(container);
			const errEl = DOM.append(container, $('div.mobile-diff-empty-state'));
			errEl.textContent = localize('diffView.loadError', "Could not load file content.");
		});
	}

	private loadDiffContent(container: HTMLElement, diff: IFileDiffViewData): void {
		const loadingEl = DOM.append(container, $('div.mobile-diff-empty-state'));
		loadingEl.textContent = localize('diffView.loading', "Loading…");

		Promise.all([
			this.textFileService.read(diff.originalURI, { acceptTextOnly: true }).then(m => m.value).catch(() => ''),
			this.textFileService.read(diff.modifiedURI, { acceptTextOnly: true }).then(m => m.value).catch(() => ''),
		]).then(([originalText, modifiedText]) => {
			if (this.activeTab !== 'diff') {
				return; // navigated away
			}
			DOM.clearNode(container);
			const hunks = computeSimpleUnifiedDiff(originalText, modifiedText);
			if (hunks.length === 0) {
				const empty = DOM.append(container, $('div.mobile-diff-empty-state'));
				empty.textContent = localize('diffView.noChanges', "No changes in this file.");
				return;
			}
			this.renderHunks(container, hunks);
		});
	}

	private renderHunks(container: HTMLElement, hunks: IDiffHunk[]): void {
		for (const hunk of hunks) {
			// Hunk header
			const headerEl = DOM.append(container, $('span.mobile-diff-hunk-header'));
			headerEl.textContent = hunk.header;

			// Lines
			for (const line of hunk.lines) {
				const row = DOM.append(container, $('div.mobile-diff-line'));
				row.classList.add(line.type);

				const numEl = DOM.append(row, $('span.mobile-diff-line-num'));
				numEl.textContent = line.lineNum !== undefined ? String(line.lineNum) : '';

				const gutter = DOM.append(row, $('span.mobile-diff-gutter'));
				gutter.textContent = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';

				const content = DOM.append(row, $('span.mobile-diff-content'));
				content.textContent = line.text;
			}
		}
	}

	override dispose(): void {
		this.viewStore.dispose();
		super.dispose();
	}
}

// -- Minimal unified diff engine -----------------------------------------------
// A lightweight LCS-based diff for rendering in the mobile view. This avoids a
// dependency on Monaco's diff engine while still producing readable output.

interface IDiffLine {
	type: 'context' | 'added' | 'removed';
	lineNum?: number;
	text: string;
}

interface IDiffHunk {
	header: string;
	lines: IDiffLine[];
}

const CONTEXT_LINES = 3;

function computeSimpleUnifiedDiff(original: string, modified: string): IDiffHunk[] {
	const origLines = original.split('\n');
	const modLines = modified.split('\n');

	// Build LCS edit script
	const edits = computeLcsEdits(origLines, modLines);

	// Group into hunks with context
	const hunks: IDiffHunk[] = [];
	let hunkLines: IDiffLine[] = [];
	let hunkOrigStart = 1;
	let hunkModStart = 1;
	let lastChangeIdx = -1;

	const flushHunk = (origEnd: number, modEnd: number) => {
		if (hunkLines.length === 0) {
			return;
		}
		const origCount = hunkLines.filter(l => l.type !== 'added').length;
		const modCount = hunkLines.filter(l => l.type !== 'removed').length;
		hunks.push({
			header: `@@ -${hunkOrigStart},${origCount} +${hunkModStart},${modCount} @@`,
			lines: [...hunkLines],
		});
		hunkLines = [];
	};

	let origIdx = 0;
	let modIdx = 0;

	for (const edit of edits) {
		if (edit.type === 'equal') {
			// Add up to CONTEXT_LINES before a change (look ahead)
			const lines = origLines.slice(origIdx, origIdx + edit.count);
			for (let i = 0; i < lines.length; i++) {
				const isNearChange = i < CONTEXT_LINES || edit.count - i <= CONTEXT_LINES;
				if (isNearChange || lastChangeIdx !== -1) {
					hunkLines.push({ type: 'context', lineNum: origIdx + i + 1, text: lines[i] });
				}
			}
			origIdx += edit.count;
			modIdx += edit.count;
		} else if (edit.type === 'remove') {
			if (hunkLines.length === 0) {
				hunkOrigStart = Math.max(1, origIdx + 1 - CONTEXT_LINES);
				hunkModStart = Math.max(1, modIdx + 1 - CONTEXT_LINES);
			}
			for (let i = 0; i < edit.count; i++) {
				hunkLines.push({ type: 'removed', lineNum: origIdx + i + 1, text: origLines[origIdx + i] });
			}
			lastChangeIdx = hunkLines.length;
			origIdx += edit.count;
		} else {
			if (hunkLines.length === 0) {
				hunkOrigStart = Math.max(1, origIdx + 1 - CONTEXT_LINES);
				hunkModStart = Math.max(1, modIdx + 1 - CONTEXT_LINES);
			}
			for (let i = 0; i < edit.count; i++) {
				hunkLines.push({ type: 'added', lineNum: modIdx + i + 1, text: modLines[modIdx + i] });
			}
			lastChangeIdx = hunkLines.length;
			modIdx += edit.count;
		}
	}

	flushHunk(origIdx, modIdx);
	return hunks;
}

interface IEdit {
	type: 'equal' | 'remove' | 'add';
	count: number;
}

function computeLcsEdits(a: string[], b: string[]): IEdit[] {
	// Myers diff — O(ND) algorithm, well-suited for typical code diffs.
	const n = a.length;
	const m = b.length;
	const max = n + m;
	const v = new Int32Array(2 * max + 2);
	const trace: Int32Array[] = [];

	for (let d = 0; d <= max; d++) {
		const snapshot = new Int32Array(v);
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			const ki = k + max;
			if (k === -d || (k !== d && v[ki - 1] < v[ki + 1])) {
				x = v[ki + 1];
			} else {
				x = v[ki - 1] + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[ki] = x;
			if (x >= n && y >= m) {
				trace.push(snapshot);
				return backtrack(trace, a, b, max);
			}
		}
		trace.push(new Int32Array(v));
	}
	return [{ type: 'remove', count: n }, { type: 'add', count: m }];
}

function backtrack(trace: Int32Array[], a: string[], b: string[], max: number): IEdit[] {
	const edits: IEdit[] = [];
	let x = a.length;
	let y = b.length;

	for (let d = trace.length - 1; d >= 0; d--) {
		const v = trace[d];
		const k = x - y;
		const ki = k + max;
		let prevK: number;
		if (k === -d || (k !== d && v[ki - 1] < v[ki + 1])) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = v[prevK + max];
		const prevY = prevX - prevK;

		while (x > prevX && y > prevY) {
			pushEdit(edits, 'equal', 1);
			x--;
			y--;
		}
		if (x > prevX) {
			pushEdit(edits, 'remove', 1);
			x--;
		} else if (y > prevY) {
			pushEdit(edits, 'add', 1);
			y--;
		}
	}

	edits.reverse();
	return mergeEdits(edits);
}

function pushEdit(edits: IEdit[], type: IEdit['type'], count: number): void {
	const last = edits[edits.length - 1];
	if (last && last.type === type) {
		last.count += count;
	} else {
		edits.push({ type, count });
	}
}

function mergeEdits(edits: IEdit[]): IEdit[] {
	// Remap 'add' → 'add' for use in the unified diff hunk builder.
	// The backtrack output uses 'add'; the hunk builder expects that.
	return edits;
}

/**
 * Opens a {@link MobileDiffView} for the given file diff.
 * Returns the view instance; dispose it to close.
 */
export function openMobileDiffView(
	workbenchContainer: HTMLElement,
	data: IMobileDiffViewData,
	textFileService: ITextFileService,
): MobileDiffView {
	return new MobileDiffView(workbenchContainer, data, textFileService);
}
