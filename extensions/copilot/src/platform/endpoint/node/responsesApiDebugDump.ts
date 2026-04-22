/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { ILogService } from '../../log/common/logService';

/**
 * Set to `true` to dump every SSE event from the Responses API to a
 * timestamped log file at the repo root. Useful for debugging phased
 * output, commentary/final_answer concatenation, and stream ordering.
 *
 * **Do not commit with this set to `true`.**
 */
const ENABLE_RESPONSES_STREAM_DUMP = false
	// || Boolean("true") // this's done this way to easily uncomment but also to not let you commit it due to internationalized string doublequote use
	;

export interface IResponsesStreamDumper {
	/** Append a single SSE event to the dump file. */
	logEvent(timestamp: Date, eventType: string, rawData: string): void;
}

const noopDumper: IResponsesStreamDumper = {
	logEvent() { /* noop */ }
};

class ResponsesStreamDumper implements IResponsesStreamDumper {
	constructor(private readonly filePath: string) { }

	logEvent(timestamp: Date, eventType: string, rawData: string): void {
		try {
			let prettyData: string;
			try { prettyData = JSON.stringify(JSON.parse(rawData), null, 2); } catch { prettyData = rawData; }
			fs.appendFileSync(this.filePath, `${timestamp.toISOString()} ${eventType}\n${prettyData}\n\n`);
		} catch {
			// Swallow write errors so debugging never breaks real functionality.
		}
	}
}

/**
 * Creates a dumper for the given request. When {@link ENABLE_RESPONSES_STREAM_DUMP}
 * is `false` this returns a no-op implementation with zero overhead.
 */
export function createResponsesStreamDumper(requestId: string, logService: ILogService): IResponsesStreamDumper {
	if (!ENABLE_RESPONSES_STREAM_DUMP) {
		return noopDumper;
	}

	try {
		const repoRoot = findRepoRoot() ?? process.cwd();
		const ts = new Date().toISOString().replace(/[:.]/g, '-');
		const filePath = path.join(repoRoot, `responses-stream-${ts}-${requestId}.log`);
		fs.writeFileSync(filePath, `# Responses API SSE stream dump\n# requestId=${requestId}\n# started=${new Date().toISOString()}\n\n`);
		logService.info(`[responsesAPI] Dumping SSE stream to ${filePath}`);
		return new ResponsesStreamDumper(filePath);
	} catch {
		return noopDumper;
	}
}

function findRepoRoot(): string | undefined {
	let dir = __dirname;
	for (let i = 0; i < 12; i++) {
		if (fs.existsSync(path.join(dir, 'product.json')) && fs.existsSync(path.join(dir, 'extensions', 'copilot'))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
	return undefined;
}
