/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { AgentSession } from './agentService.js';
import { buildSkillInvocationPrompt } from './agentHostSkillInvocation.js';
import { readSessionReferenceAttachmentMeta } from './meta/agentSessionReferenceMeta.js';
import type { MessageAttachment } from './state/protocol/state.js';

/**
 * The name of the built-in troubleshoot skill and the leading slash-command the
 * user types (`/troubleshoot`). The same command name is used across every
 * harness (each bundles its own `troubleshoot` skill describing its own logs),
 * so the send-path can recognize a troubleshoot request harness-agnostically.
 */
export const TROUBLESHOOT_SKILL_NAME = 'troubleshoot';

/**
 * Result of {@link augmentTroubleshootRequest}: the rewritten prompt and the
 * attachments to forward to the model.
 */
export interface ITroubleshootRequest {
	readonly prompt: string;
	readonly attachments: readonly MessageAttachment[] | undefined;
}

/**
 * Rewrites a `/troubleshoot` request into a message that invokes the built-in
 * `troubleshoot` skill:
 *
 *   Use the skill tool to invoke the 'troubleshoot' skill, then follow the
 *   skill's instructions.
 *
 *   Session log: <path(s)>
 *
 * An explicit `#session` reference pins the referenced session's log path (and
 * its marker attachments are dropped, consumed here rather than forwarded). A
 * bare `/troubleshoot` injects no path, so the skill continues the session
 * already established earlier in the conversation (its sticky-reference rule),
 * or self-discovers the current session on a first call. The user's genuine
 * free text is always forwarded as context, with the inserted `#session:<title>`
 * marker text stripped out so only a real question (if any) survives - e.g.
 * `/troubleshoot #session:Build why was the test skipped?` keeps "why was the
 * test skipped?".
 *
 * Harness-agnostic: each harness supplies `resolveSessionLogPath`, mapping a raw
 * session id to that harness's on-disk log (Copilot CLI's `events.jsonl`,
 * Claude's transcript, etc.), keeping this a pure, unit-testable function.
 */
export function augmentTroubleshootRequest(
	userInstructions: string,
	attachments: readonly MessageAttachment[] | undefined,
	resolveSessionLogPath: (sessionId: string) => string,
): ITroubleshootRequest {
	const referencedIds: string[] = [];
	const remaining: MessageAttachment[] = [];
	const markerLabels: string[] = [];
	for (const attachment of attachments ?? []) {
		const meta = readSessionReferenceAttachmentMeta(attachment._meta);
		if (meta) {
			// Resolve the raw session id from the resource the same way the
			// current session id is derived, so it matches the on-disk session
			// folder regardless of the meta's own id.
			try {
				referencedIds.push(AgentSession.id(URI.parse(meta.sessionResource)));
			} catch {
				// Ignore an unparseable reference.
			}
			// Remember the inserted marker text (`#session:<label>`) so it can be
			// stripped from the user's free text below.
			markerLabels.push(attachment.label);
		} else {
			remaining.push(attachment);
		}
	}

	const parts = [buildSkillInvocationPrompt(TROUBLESHOOT_SKILL_NAME)];
	// Pin the log path only for an explicit `#session` reference. A bare
	// `/troubleshoot` injects no path so the skill continues the session already
	// established earlier in the conversation, or self-discovers the current one.
	if (referencedIds.length) {
		const logPaths = Array.from(new Set(referencedIds.map(resolveSessionLogPath)));
		if (logPaths.length) {
			parts.push(`Session log: ${logPaths.join(', ')}`);
		}
	}
	// Forward the user's genuine free text, stripping the inserted
	// `#session:<title>` marker(s) - their target is conveyed via the log path
	// above, so what remains is any real question the user typed alongside the
	// reference (e.g. "#session:Build why was the test skipped?").
	let instructions = userInstructions;
	for (const label of markerLabels) {
		instructions = instructions.replace(`#session:${label}`, ' ');
	}
	instructions = instructions.trim();
	if (instructions) {
		parts.push(`Additional context from the user:\n${instructions}`);
	}

	// Drop the `#session` markers; forward any other (real) attachments.
	const nextAttachments = referencedIds.length ? remaining : attachments;
	return { prompt: parts.join('\n\n'), attachments: nextAttachments };
}
