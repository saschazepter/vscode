/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ICopilotTokenManager } from '../../../platform/authentication/common/copilotTokenManager';
import { ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ISessionStore } from '../../../platform/chronicle/common/sessionStore';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { getGitHubRepoInfoFromContext, IGitService } from '../../../platform/git/common/gitService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LanguageModelChatMessage } from '../../../vscodeTypes';
import { type AnnotatedRef, type AnnotatedSession, type SessionFileInfo, type SessionTurnInfo, buildStandupPrompt } from '../../chronicle/common/standupPrompt';
import { SessionIndexingPreference } from '../../chronicle/common/sessionIndexingPreference';
import { CloudSessionStoreClient } from '../../chronicle/node/cloudSessionStoreClient';
import { IToolsService } from '../../tools/common/toolsService';
import { Conversation } from '../../prompt/common/conversation';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IIntent, IIntentInvocation, IIntentInvocationContext, IIntentSlashCommandInfo, NullIntentInvocation } from '../../prompt/node/intents';

/** DuckDB-dialect sessions query (cloud uses DuckDB, not SQLite). */
const SESSIONS_QUERY_DUCKDB = `SELECT id, summary, branch, repository, cwd, created_at, updated_at
	FROM sessions
	ORDER BY updated_at DESC
	LIMIT 50`;

const SUBCOMMANDS = ['standup', 'tips', 'improve'] as const;
type ChronicleSubcommand = typeof SUBCOMMANDS[number];

export class ChronicleIntent implements IIntent {

	static readonly ID = 'chronicle';
	readonly id = ChronicleIntent.ID;
	readonly locations = [ChatLocation.Panel];
	readonly description = l10n.t('Session history tools and insights (standup, tips, improve)');

	readonly commandInfo: IIntentSlashCommandInfo = {
		allowsEmptyArgs: true,
	};

	constructor(
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@ISessionStore _sessionStore: ISessionStore, // temporarily unused — cloud-only testing
		@ICopilotTokenManager private readonly _tokenManager: ICopilotTokenManager,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@IGitService private readonly _gitService: IGitService,
		@IConfigurationService private readonly _configService: IConfigurationService,
	) {
		this._indexingPreference = new SessionIndexingPreference(this._extensionContext);
	}

	private readonly _indexingPreference: SessionIndexingPreference;

	async handleRequest(
		_conversation: Conversation,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: CancellationToken,
		_documentContext: IDocumentContext | undefined,
		_agentName: string,
		_location: ChatLocation,
		_chatTelemetry: ChatTelemetryBuilder,
	): Promise<vscode.ChatResult> {
		if (!this._configService.getConfig(ConfigKey.TeamInternal.SessionSearchEnabled)) {
			stream.markdown(l10n.t('Session search is not enabled. Set `github.copilot.chat.advanced.sessionSearch.enabled` to `true` in settings to enable this feature.'));
			return {};
		}

		const { subcommand, rest } = this._parseSubcommand(request.prompt);

		switch (subcommand) {
			case 'standup':
				return this._handleStandup(rest, stream, request, token);
			case 'tips':
			case 'improve':
				stream.markdown(l10n.t('`/chronicle {0}` is not yet implemented. Try `/chronicle standup`.', subcommand));
				return {};
			default: {
				stream.markdown(l10n.t(
					'Unknown subcommand `{0}`. Available subcommands: {1}',
					subcommand,
					SUBCOMMANDS.join(', '),
				));
				return {};
			}
		}
	}

	private _parseSubcommand(prompt: string | undefined): { subcommand: ChronicleSubcommand | string; rest: string | undefined } {
		const trimmed = prompt?.trim() ?? '';
		if (!trimmed) {
			return { subcommand: 'standup', rest: undefined };
		}
		const spaceIdx = trimmed.indexOf(' ');
		if (spaceIdx === -1) {
			return { subcommand: trimmed.toLowerCase(), rest: undefined };
		}
		return {
			subcommand: trimmed.slice(0, spaceIdx).toLowerCase(),
			rest: trimmed.slice(spaceIdx + 1).trim() || undefined,
		};
	}

	private async _handleStandup(
		extra: string | undefined,
		stream: vscode.ChatResponseStream,
		request: vscode.ChatRequest,
		token: CancellationToken,
	): Promise<vscode.ChatResult> {
		// Check if user needs to consent to session indexing
		// This shows the inline askQuestions UI on first use per repo
		await this._checkSessionIndexingConsent(request, token);

		console.log('[Chronicle] _handleStandup called');
		// VS Code local store disabled temporarily for cloud-only testing
		// const vscodeSessions = this._queryStore(this.sessionStore, 'vscode');

		// CLI store disabled temporarily
		// const cliSessions = this._queryCliStore();

		// Query cloud session store (cross-machine sessions)
		const cloudSessions = await this._queryCloudStore();

		console.log(`[Chronicle] Cloud: ${cloudSessions.sessions.length} sessions (cloud-only mode)`);

		// Cloud-only for testing
		const MAX_SESSIONS_PER_SOURCE = 20;
		const cappedCloud = this._capResults(cloudSessions, MAX_SESSIONS_PER_SOURCE);

		const sessions: AnnotatedSession[] = [...cappedCloud.sessions];
		const refs: AnnotatedRef[] = [...cappedCloud.refs];
		const files: SessionFileInfo[] = [...cappedCloud.files];
		const turns: SessionTurnInfo[] = [...cappedCloud.turns];

		// Sort merged results by updated_at descending
		sessions.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));

		const standupPrompt = buildStandupPrompt(sessions, refs, extra, files, turns);
		console.log(`[Chronicle] Prompt size: ${standupPrompt.length} chars, cloud sessions in prompt: ${sessions.filter(s => s.source === 'cloud').length}`);

		if (sessions.length === 0) {
			stream.markdown(l10n.t('No sessions found in the last 24 hours. There\'s nothing to report for a standup.'));
			return {};
		}

		const cloudCount = cloudSessions.sessions.length;
		stream.progress(l10n.t('Generating standup from {0} cloud session(s)...', cloudCount));

		const model = request.model;
		const messages = [
			LanguageModelChatMessage.User(standupPrompt),
		];

		const response = await model.sendRequest(messages, {}, token);

		for await (const part of response.text) {
			stream.markdown(part);
		}

		return {};
	}

	/* Temporarily disabled — cloud-only testing
	private _queryStore(store: ISessionStore, source: 'vscode' | 'cli'): { sessions: AnnotatedSession[]; refs: AnnotatedRef[]; files: SessionFileInfo[]; turns: SessionTurnInfo[] } {
		try {
			const rawSessions = store.executeReadOnly(SESSIONS_QUERY_SQLITE) as unknown as SessionRow[];
			const sessions: AnnotatedSession[] = rawSessions.map(s => ({ ...s, source }));

			let refs: AnnotatedRef[] = [];
			let files: SessionFileInfo[] = [];
			let turns: SessionTurnInfo[] = [];
			if (sessions.length > 0) {
				const ids = sessions.map(s => s.id);
				const rawRefs = store.executeReadOnly(buildRefsQuery(ids)) as unknown as RefRow[];
				refs = rawRefs.map(r => ({ ...r, source }));
				files = store.executeReadOnly(buildFilesQuery(ids)) as unknown as SessionFileInfo[];
				turns = store.executeReadOnly(buildTurnsQuery(ids)) as unknown as SessionTurnInfo[];
			}

			return { sessions, refs, files, turns };
		} catch {
			return { sessions: [], refs: [], files: [], turns: [] };
		}
	}

	private _queryCliStore(): { sessions: AnnotatedSession[]; refs: AnnotatedRef[]; files: SessionFileInfo[]; turns: SessionTurnInfo[] } {
		const cliDbPath = join(homedir(), '.copilot', 'session-store.db');
		if (!existsSync(cliDbPath)) {
			console.log('[Chronicle] CLI DB not found at', cliDbPath);
			return { sessions: [], refs: [], files: [], turns: [] };
		}

		let cliStore: SessionStore | undefined;
		try {
			console.log('[Chronicle] Opening CLI DB at', cliDbPath);
			cliStore = new SessionStore(cliDbPath);
			const result = this._queryStore(cliStore, 'cli');
			console.log(`[Chronicle] CLI DB returned ${result.sessions.length} sessions, ${result.refs.length} refs, ${result.files.length} files, ${result.turns.length} turns`);
			return result;
		} catch (err) {
			console.error('[Chronicle] Error querying CLI DB:', err);
			return { sessions: [], refs: [], files: [], turns: [] };
		} finally {
			cliStore?.close();
		}
	}
	*/

	/**
	 * Check if the user has consented to session indexing for the current repo.
	 * If not, show the inline askQuestions consent UI.
	 */
	private async _checkSessionIndexingConsent(
		request: vscode.ChatRequest,
		token: CancellationToken,
	): Promise<void> {
		try {
			// Resolve repo NWO from active git repository
			const repoContext = this._gitService.activeRepository?.get();
			if (!repoContext) {
				return;
			}
			const repoInfo = getGitHubRepoInfoFromContext(repoContext);
			if (!repoInfo) {
				return;
			}
			const repoNwo = `${repoInfo.id.org}/${repoInfo.id.repo}`;

			const existing = this._indexingPreference.getPreference(repoNwo);
			if (existing) {
				return; // Already consented
			}

			// Show inline consent UI
			const level = await this._indexingPreference.promptUserInline(
				repoNwo,
				this._toolsService,
				request.toolInvocationToken,
				token,
			);
			console.log(`[Chronicle] User selected indexing level: ${level ?? 'dismissed'} for ${repoNwo}`);
		} catch (err) {
			console.error('[Chronicle] Consent check failed:', err);
		}
	}

	private async _queryCloudStore(): Promise<{ sessions: AnnotatedSession[]; refs: AnnotatedRef[]; files: SessionFileInfo[]; turns: SessionTurnInfo[] }> {
		const empty = { sessions: [] as AnnotatedSession[], refs: [] as AnnotatedRef[], files: [] as SessionFileInfo[], turns: [] as SessionTurnInfo[] };
		try {
			const client = new CloudSessionStoreClient(this._tokenManager, this._authService);

			// Diagnostics: check what tables and data exist
			/*	const diagQueries = [
					{ label: 'session count', sql: 'SELECT count(*) as total FROM sessions' },
					{ label: 'event count', sql: 'SELECT count(*) as total FROM events' },
					{ label: 'turns count', sql: 'SELECT count(*) as total FROM turns' },
					{ label: 'session_files count', sql: 'SELECT count(*) as total FROM session_files' },
					{ label: 'session_refs count', sql: 'SELECT count(*) as total FROM session_refs' },
					{ label: 'tool_requests count', sql: 'SELECT count(*) as total FROM tool_requests' },
					{ label: 'checkpoints count', sql: 'SELECT count(*) as total FROM checkpoints' },
				];
				for (const { label, sql } of diagQueries) {
					try {
						const r = await client.executeQuery(sql);
						console.log(`[Chronicle] Diag [${label}]: ${r ? JSON.stringify(r.rows) : 'failed'}`);
					} catch {
						console.log(`[Chronicle] Diag [${label}]: query error`);
					}
				}*/

			// Query sessions
			console.log('[Chronicle] Querying cloud sessions...');
			const sessionsResult = await client.executeQuery(SESSIONS_QUERY_DUCKDB);
			console.log(`[Chronicle] Sessions query result: ${sessionsResult ? `${sessionsResult.rows.length} rows, truncated=${sessionsResult.truncated}` : 'undefined (query failed)'}`);

			if (!sessionsResult || sessionsResult.rows.length === 0) {
				console.log('[Chronicle] Cloud returned no sessions');
				return empty;
			}

			const sessions: AnnotatedSession[] = sessionsResult.rows.map(r => ({
				id: r.id as string,
				summary: r.summary as string | undefined,
				branch: r.branch as string | undefined,
				repository: r.repository as string | undefined,
				cwd: r.cwd as string | undefined,
				created_at: r.created_at as string | undefined,
				updated_at: r.updated_at as string | undefined,
				source: 'cloud' as const,
			}));

			const ids = sessions.map(s => s.id);
			const refs: AnnotatedRef[] = [];
			const turns: SessionTurnInfo[] = [];
			const files: SessionFileInfo[] = [];

			// Resolve session origin (producer) from session.start events
			try {
				const producerQuery = `SELECT session_id, producer
					FROM events
					WHERE session_id IN (${ids.map(s => `'${s.replace(/'/g, '\'\'')}'`).join(',')})
					AND type = 'session.start'`;
				const producerResult = await client.executeQuery(producerQuery);
				console.log(`[Chronicle] Producer query returned ${producerResult?.rows.length ?? 'undefined'} rows`);
				if (producerResult && producerResult.rows.length > 0) {
					for (const row of producerResult.rows) {
						const session = sessions.find(s => s.id === row.session_id);
						if (session && row.producer) {
							const producer = row.producer as string;
							if (producer.includes('vscode')) {
								session.host_type = 'vscode';
							} else if (producer === 'copilot-agent') {
								session.host_type = 'cli';
							} else if (producer === 'sse-parser') {
								session.host_type = 'pr-review';
							} else {
								session.host_type = producer;
							}
						}
					}
				}
			} catch (err) {
				// producer column may not exist — non-fatal
				console.log('[Chronicle] Cloud producer query failed (non-fatal):', err);
			}

			// Query the raw events table — MC stores our events here.
			// The derived tables (turns, session_files) are not populated for VS Code sessions yet.
			try {
				// Use ROW_NUMBER to get up to 30 events per session, ensuring fair distribution
				const eventsQuery = `SELECT session_id, type, user_content, assistant_content, tool_start_name
					FROM (
						SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp) as rn
						FROM events
						WHERE session_id IN (${ids.map(s => `'${s.replace(/'/g, '\'\'')}'`).join(',')})
						AND type IN ('user.message', 'assistant.message', 'tool.execution_start', 'tool.execution_complete', 'session.requested')
					) sub
					WHERE rn <= 50
					ORDER BY session_id, rn`;
				const eventsResult = await client.executeQuery(eventsQuery);
				console.log(`[Chronicle] Cloud events returned ${eventsResult?.rows.length ?? 0} rows`);

				if (eventsResult && eventsResult.rows.length > 0) {
					// Log per-session event counts
					const sessionEventCounts = new Map<string, number>();
					for (const row of eventsResult.rows) {
						const sid = row.session_id as string;
						sessionEventCounts.set(sid, (sessionEventCounts.get(sid) ?? 0) + 1);
					}
					console.log(`[Chronicle] Events per session: ${JSON.stringify(Object.fromEntries(sessionEventCounts))}`);

					// Log event type distribution
					const typeCounts = new Map<string, number>();
					for (const row of eventsResult.rows) {
						const type = row.type as string;
						typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
					}
					console.log(`[Chronicle] Event types: ${JSON.stringify(Object.fromEntries(typeCounts))}`);

					// Synthesize turns from events
					let turnIndex = 0;
					const toolNames = new Set<string>();

					for (const row of eventsResult.rows) {
						const sessionId = row.session_id as string;
						const type = row.type as string;

						// user.message or session.requested → user turn
						if (type === 'user.message' || type === 'session.requested') {
							const content = (row.user_content ?? row.assistant_content) as string | undefined;
							if (content) {
								turns.push({
									session_id: sessionId,
									turn_index: turnIndex++,
									user_message: content.length > 500 ? content.slice(0, 500) + '...' : content,
								});
							}
						}

						// assistant.message → attach to previous turn or create standalone
						if (type === 'assistant.message') {
							const content = (row.assistant_content ?? row.user_content) as string | undefined;
							if (content) {
								const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;
								if (lastTurn && lastTurn.session_id === sessionId && !lastTurn.assistant_response) {
									lastTurn.assistant_response = content.length > 1000 ? content.slice(0, 1000) + '...' : content;
								} else {
									turns.push({
										session_id: sessionId,
										turn_index: turnIndex++,
										assistant_response: content.length > 1000 ? content.slice(0, 1000) + '...' : content,
									});
								}
							}
						}

						// tool events → collect tool names
						if ((type === 'tool.execution_start' || type === 'tool.execution_complete') && row.tool_start_name) {
							toolNames.add(`${sessionId}::${row.tool_start_name as string}`);
						}
					}

					// Synthesize tool usage entries
					for (const key of toolNames) {
						const [sessionId, toolName] = key.split('::');
						files.push({ session_id: sessionId, file_path: toolName, tool_name: toolName });
					}
				}
			} catch (err) {
				console.error('[Chronicle] Cloud events query failed:', err);
			}

			// Log per-session turn counts
			const turnsBySessionId = new Map<string, number>();
			for (const t of turns) {
				turnsBySessionId.set(t.session_id, (turnsBySessionId.get(t.session_id) ?? 0) + 1);
			}
			console.log(`[Chronicle] Turns per session: ${JSON.stringify(Object.fromEntries(turnsBySessionId))}`);

			console.log(`[Chronicle] Cloud returned ${sessions.length} sessions, ${refs.length} refs, ${files.length} files, ${turns.length} turns`);
			return { sessions, refs, files, turns };
		} catch (err) {
			console.error('[Chronicle] Cloud query failed:', err);
			return empty;
		}
	}

	/**
	 * Cap query results to the N most recent sessions, keeping only related refs/files/turns.
	 */
	private _capResults(
		results: { sessions: AnnotatedSession[]; refs: AnnotatedRef[]; files: SessionFileInfo[]; turns: SessionTurnInfo[] },
		max: number,
	): { sessions: AnnotatedSession[]; refs: AnnotatedRef[]; files: SessionFileInfo[]; turns: SessionTurnInfo[] } {
		if (results.sessions.length <= max) {
			return results;
		}
		const kept = results.sessions.slice(0, max);
		const keptIds = new Set(kept.map(s => s.id));
		return {
			sessions: kept,
			refs: results.refs.filter(r => keptIds.has(r.session_id)),
			files: results.files.filter(f => keptIds.has(f.session_id)),
			turns: results.turns.filter(t => keptIds.has(t.session_id)),
		};
	}

	async invoke(invocationContext: IIntentInvocationContext): Promise<IIntentInvocation> {
		const { location, request } = invocationContext;
		const endpoint = await this.endpointProvider.getChatEndpoint(request);
		return new NullIntentInvocation(this, location, endpoint);
	}
}
