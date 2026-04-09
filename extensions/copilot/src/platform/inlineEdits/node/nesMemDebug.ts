/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

import { NES_BUILD_TIMESTAMP } from './nesBuildTimestamp';
const buildTimestamp = NES_BUILD_TIMESTAMP;

const sessionStart = new Date().toISOString().replace(/[:.]/g, '-');
const debugDir = path.join('D:\\workspace\\docs\\projects\\NES\\oom-issue-294050', `session-${sessionStart}`);

function ensureDir(): void {
	try {
		if (!fs.existsSync(debugDir)) {
			fs.mkdirSync(debugDir, { recursive: true });
		}
	} catch {
		// ignore
	}
}

function timestamp(): string {
	return new Date().toISOString();
}

function heapMB(): string {
	const usage = process.memoryUsage();
	return `heap=${Math.round(usage.heapUsed / 1024 / 1024)}MB`;
}

function heapUsedBytes(): number {
	return process.memoryUsage().heapUsed;
}

function appendToFile(filename: string, line: string): void {
	ensureDir();
	try {
		const filePath = path.join(debugDir, filename);
		// Write build header on first write to each file
		if (!fs.existsSync(filePath)) {
			fs.writeFileSync(filePath, `# Build: ${buildTimestamp} | Session: ${sessionStart}\n`);
		}
		fs.appendFileSync(filePath, line + '\n');
	} catch {
		// ignore
	}
}

export function getNesBuildTimestamp(): string {
	return buildTimestamp;
}

export function getNesDebugDir(): string {
	return debugDir;
}

// ─── Auto heap snapshot at 3.5 GB ──────────────────────────────────────────
const heapSnapshotThreshold = 2.2 * 1024 * 1024 * 1024;
let heapSnapshotTaken = false;

function checkHeapAndSnapshot(): void {
	if (heapSnapshotTaken) {
		return;
	}
	const used = heapUsedBytes();
	if (used >= heapSnapshotThreshold) {
		heapSnapshotTaken = true;
		const mb = Math.round(used / 1024 / 1024);
		console.log(`[NES-OOM-FIX] Heap at ${mb}MB, taking snapshot...`);
		try {
			const v8 = require('v8');
			const snapshotFile = path.join(debugDir, `auto-heap-${new Date().toISOString().replace(/[:.]/g, '-')}.heapsnapshot`);
			v8.writeHeapSnapshot(snapshotFile);
			console.log(`[NES-OOM-FIX] Heap snapshot saved to ${snapshotFile}`);
			appendToFile('h0-heap-snapshots.log', `${timestamp()} ${heapMB()} snapshot=${snapshotFile}`);
		} catch (e) {
			console.log(`[NES-OOM-FIX] Failed to take heap snapshot: ${e}`);
		}
	}
}

// ─── Hypothesis 1: DeferredPromise lifecycle ───────────────────────────────

const h1File = 'h1-deferred-promise.log';
const h1Alive = new Map<string, { createdAt: number; isSpeculative: boolean; docSize: number }>();

export function h1_requestCreated(seqid: string, isSpeculative: boolean, docSize: number): void {
	h1Alive.set(seqid, { createdAt: Date.now(), isSpeculative, docSize });
	appendToFile(h1File, `${timestamp()} CREATE  seqid=${seqid} spec=${isSpeculative} docSize=${docSize} alive=${h1Alive.size} ${heapMB()}`);
}

export function h1_resultSet(seqid: string): void {
	const info = h1Alive.get(seqid);
	const ageMs = info ? Date.now() - info.createdAt : '?';
	h1Alive.delete(seqid);
	appendToFile(h1File, `${timestamp()} RESOLVE seqid=${seqid} ageMs=${ageMs} alive=${h1Alive.size} ${heapMB()}`);
}

export function h1_resultError(seqid: string): void {
	const info = h1Alive.get(seqid);
	const ageMs = info ? Date.now() - info.createdAt : '?';
	h1Alive.delete(seqid);
	appendToFile(h1File, `${timestamp()} ERROR   seqid=${seqid} ageMs=${ageMs} alive=${h1Alive.size} ${heapMB()}`);
}

export function h1_cancelled(seqid: string, context: string): void {
	const info = h1Alive.get(seqid);
	const pending = info ? 'PENDING' : 'already-resolved';
	appendToFile(h1File, `${timestamp()} CANCEL  seqid=${seqid} status=${pending} context=${context} alive=${h1Alive.size} ${heapMB()}`);
}

export function h1_streamBgStart(seqid: string): void {
	appendToFile(h1File, `${timestamp()} BG-START seqid=${seqid}`);
}

export function h1_streamBgEnd(seqid: string, outcome: string): void {
	appendToFile(h1File, `${timestamp()} BG-END  seqid=${seqid} outcome=${outcome}`);
}

export function h1_specCatchNoResolve(seqid: string, error: string): void {
	const info = h1Alive.get(seqid);
	const pending = info ? 'STILL-PENDING' : 'already-resolved';
	appendToFile(h1File, `${timestamp()} SPEC-CATCH-NO-RESOLVE seqid=${seqid} resultStatus=${pending} error=${error} alive=${h1Alive.size} ${heapMB()}`);
}

// periodic dump of all alive requests
let h1DumpInterval: ReturnType<typeof setInterval> | undefined;
export function h1_startPeriodicDump(): void {
	if (h1DumpInterval) { return; }
	h1DumpInterval = setInterval(() => {
		checkHeapAndSnapshot();
		if (h1Alive.size === 0) { return; }
		const now = Date.now();
		const lines: string[] = [];
		for (const [seqid, info] of h1Alive) {
			lines.push(`  seqid=${seqid} spec=${info.isSpeculative} docSize=${info.docSize} ageMs=${now - info.createdAt}`);
		}
		appendToFile(h1File, `${timestamp()} ALIVE-DUMP count=${h1Alive.size} ${heapMB()}\n${lines.join('\n')}`);
	}, 10_000);
}

// ─── Hypothesis 2: TelemetrySender._map lifecycle ──────────────────────────

const h2File = 'h2-telemetry-map.log';

export function h2_scheduled(requestId: number, mapSize: number): void {
	appendToFile(h2File, `${timestamp()} SCHEDULE requestId=${requestId} mapSize=${mapSize} ${heapMB()}`);
}

export function h2_enterIdle(requestId: number, mapSize: number): void {
	appendToFile(h2File, `${timestamp()} IDLE-ENTER requestId=${requestId} mapSize=${mapSize} ${heapMB()}`);
}

export function h2_sent(requestId: number, reason: string, mapSize: number): void {
	appendToFile(h2File, `${timestamp()} SENT requestId=${requestId} reason=${reason} mapSize=${mapSize} ${heapMB()}`);
}

export function h2_removed(requestId: number, reason: string, mapSize: number): void {
	appendToFile(h2File, `${timestamp()} REMOVED requestId=${requestId} reason=${reason} mapSize=${mapSize} ${heapMB()}`);
}

// ─── Hypothesis 3: DebugRecorder memory ────────────────────────────────────

const h3File = 'h3-debug-recorder.log';

export function h3_cleanUpHistory(docId: string, baseValueSize: number, editsCount: number, evictedCount: number): void {
	appendToFile(h3File, `${timestamp()} CLEANUP docId=${docId} baseValueSize=${baseValueSize} editsCount=${editsCount} evicted=${evictedCount} ${heapMB()}`);
}

export function h3_getRecentLog(totalEntries: number, jsonSize: number, wasCapped: boolean): void {
	appendToFile(h3File, `${timestamp()} GET-LOG entries=${totalEntries} jsonSize=${jsonSize} capped=${wasCapped} ${heapMB()}`);
}

export function h3_baseValueUpdate(docId: string, oldSize: number, newSize: number): void {
	appendToFile(h3File, `${timestamp()} BASE-UPDATE docId=${docId} oldSize=${oldSize} newSize=${newSize}`);
}

// ─── Hypothesis 4: Large string creation tracking ──────────────────────────

const h4File = 'h4-large-strings.log';
const LARGE_STRING_THRESHOLD = 1024 * 1024; // 1MB

export function h4_docValueGet(context: string, size: number): void {
	if (size > LARGE_STRING_THRESHOLD) {
		appendToFile(h4File, `${timestamp()} DOC-GET context=${context} size=${size} ${heapMB()}`);
	}
}

export function h4_newStatelessNextEditDoc(docId: string, docBeforeSize: number, docAfterSize: number, linesCount: number): void {
	if (docBeforeSize > LARGE_STRING_THRESHOLD || docAfterSize > LARGE_STRING_THRESHOLD) {
		appendToFile(h4File, `${timestamp()} NEW-SNEDOC docId=${docId} beforeSize=${docBeforeSize} afterSize=${docAfterSize} lines=${linesCount} ${heapMB()}`);
	}
}

export function h4_newStatelessNextEditRequest(seqid: string, docBeforeSize: number, docsCount: number, totalDocBytes: number): void {
	appendToFile(h4File, `${timestamp()} NEW-SNEQ seqid=${seqid} docBeforeSize=${docBeforeSize} docsCount=${docsCount} totalDocBytes=${totalDocBytes} ${heapMB()}`);
}
