/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../base/common/uri.js';
import { IFileEdit, SessionStatus as ProtocolSessionStatus } from '../../platform/agentHost/common/state/protocol/state.js';
import { SessionStatus } from '../services/sessions/common/session.js';

/**
 * Maps the protocol-layer session status bitset to the UI-layer
 * {@link SessionStatus} enum used by session adapters.
 */
export function mapProtocolStatus(protocol: ProtocolSessionStatus): SessionStatus {
	if ((protocol & ProtocolSessionStatus.InputNeeded) === ProtocolSessionStatus.InputNeeded) {
		return SessionStatus.NeedsInput;
	}
	if (protocol & ProtocolSessionStatus.InProgress) {
		return SessionStatus.InProgress;
	}
	if (protocol & ProtocolSessionStatus.Error) {
		return SessionStatus.Error;
	}
	return SessionStatus.Completed;
}

export interface IFileChange {
	readonly modifiedUri: URI;
	readonly insertions: number;
	readonly deletions: number;
}

/**
 * Converts agent host diffs to the chat session file change format.
 *
 * @param mapUri Optional URI mapper applied after parsing. The remote agent
 *   host provider uses this to rewrite `file:` URIs into agent-host URIs.
 */
export function diffsToChanges(diffs: readonly IFileEdit[], mapUri?: (uri: URI) => URI): IFileChange[] {
	const result: IFileChange[] = [];
	for (const diff of diffs) {
		const modifiedUri = mapEditUri(diff, mapUri);
		if (!modifiedUri) {
			continue;
		}
		result.push({
			modifiedUri,
			insertions: diff.diff?.added ?? 0,
			deletions: diff.diff?.removed ?? 0,
		});
	}
	return result;
}

/**
 * Returns `true` when the current file changes already
 * match the incoming raw diffs, avoiding unnecessary observable updates.
 */
export function diffsEqual(current: readonly IFileChange[], raw: readonly IFileEdit[], mapUri?: (uri: URI) => URI): boolean {
	if (current.length !== raw.length) {
		return false;
	}
	for (let i = 0; i < current.length; i++) {
		const currentChange = current[i];
		const rawDiff = raw[i];
		const rawUri = mapEditUri(rawDiff, mapUri);
		if (!rawUri || currentChange.modifiedUri.toString() !== rawUri.toString() || currentChange.insertions !== (rawDiff.diff?.added ?? 0) || currentChange.deletions !== (rawDiff.diff?.removed ?? 0)) {
			return false;
		}
	}
	return true;
}

function mapEditUri(edit: IFileEdit, mapUri?: (uri: URI) => URI): URI | undefined {
	const uri = edit.after?.uri ?? edit.before?.uri;
	if (!uri) {
		return undefined;
	}
	const parsedUri = URI.parse(uri);
	return mapUri ? mapUri(parsedUri) : parsedUri;
}
