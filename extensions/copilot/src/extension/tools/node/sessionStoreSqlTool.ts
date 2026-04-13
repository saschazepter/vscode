/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ICopilotTokenManager } from '../../../platform/authentication/common/copilotTokenManager';
import { ISessionStore } from '../../../platform/chronicle/common/sessionStore';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart } from '../../../vscodeTypes';
import { SessionIndexingPreference } from '../../chronicle/common/sessionIndexingPreference';
import { CloudSessionStoreClient } from '../../chronicle/node/cloudSessionStoreClient';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

/** Max rows to return to avoid blowing up the context window. */
const MAX_ROWS = 200;

/** Dangerous SQL patterns that should be blocked. */
const BLOCKED_PATTERNS = [
	/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE)\b/i,
	/\bATTACH\b/i,
	/\bDETACH\b/i,
	/\bPRAGMA\b(?!\s+data_version)/i,
];

export interface SessionStoreSqlParams {
	readonly query: string;
	readonly description: string;
}

class SessionStoreSqlTool implements ICopilotTool<SessionStoreSqlParams> {
	public static readonly toolName = ToolName.SessionStoreSql;
	public static readonly nonDeferred = true;

	private readonly _indexingPreference: SessionIndexingPreference;

	constructor(
		@ISessionStore private readonly _sessionStore: ISessionStore,
		@ICopilotTokenManager private readonly _tokenManager: ICopilotTokenManager,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@IConfigurationService configService: IConfigurationService,
	) {
		this._indexingPreference = new SessionIndexingPreference(configService);
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<SessionStoreSqlParams>,
		token: CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const sql = options.input.query.trim();

		if (!sql) {
			return new LanguageModelToolResultImpl([new LanguageModelTextPart('Error: Empty query provided.')]);
		}

		// Security check: block mutating statements
		for (const pattern of BLOCKED_PATTERNS) {
			if (pattern.test(sql)) {
				return new LanguageModelToolResultImpl([
					new LanguageModelTextPart(`Error: Blocked SQL statement. Only SELECT queries are allowed.`),
				]);
			}
		}

		// Determine query target based on consent
		const hasCloud = this._indexingPreference.hasCloudConsent();
		console.log(`[SessionStoreSql] invoke: hasCloud=${hasCloud}, sql=${sql.substring(0, 100)}`);

		try {
			let rows: Record<string, unknown>[];
			let truncated = false;
			let source: string;

			if (hasCloud) {
				source = 'cloud';
				const client = new CloudSessionStoreClient(this._tokenManager, this._authService);
				const result = await client.executeQuery(sql);
				console.log(`[SessionStoreSql] cloud result: ${result ? `${result.rows.length} rows` : 'null'}`);
				if (!result) {
					return new LanguageModelToolResultImpl([new LanguageModelTextPart('Error: Cloud query returned no result.')]);
				}
				rows = result.rows;
				truncated = result.truncated;
			} else {
				source = 'local';
				try {
					rows = this._sessionStore.executeReadOnly(sql);
				} catch (authErr) {
					if (authErr instanceof Error && authErr.message.includes('authorizer')) {
						// Fallback: authorizer not available (Node.js < 24.2).
						// SQL is already validated by BLOCKED_PATTERNS above, so
						// execute directly without engine-level enforcement.
						rows = this._sessionStore.executeReadOnlyFallback(sql);
					} else {
						throw authErr;
					}
				}
				console.log(`[SessionStoreSql] local result: ${rows.length} rows`);
			}

			// Cap rows
			if (rows.length > MAX_ROWS) {
				rows = rows.slice(0, MAX_ROWS);
				truncated = true;
			}

			// Format as table
			const result = formatSqlResult(rows, truncated, source);
			return new LanguageModelToolResultImpl([new LanguageModelTextPart(result)]);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return new LanguageModelToolResultImpl([new LanguageModelTextPart(`Error: ${message}`)]);
		}
	}

	prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<SessionStoreSqlParams>,
		_token: CancellationToken,
	) {
		return {
			invocationMessage: l10n.t('Querying session store'),
			pastTenseMessage: l10n.t('Queried session store'),
		};
	}
}

function formatSqlResult(rows: Record<string, unknown>[], truncated: boolean, source: string): string {
	if (rows.length === 0) {
		return `No results found (source: ${source}).`;
	}

	const columns = Object.keys(rows[0]);
	const lines: string[] = [];
	lines.push(`Results: ${rows.length} rows (source: ${source})${truncated ? ' [TRUNCATED]' : ''}`);
	lines.push('');
	lines.push(`| ${columns.join(' | ')} |`);
	lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
	for (const row of rows) {
		const values = columns.map(c => {
			const v = row[c];
			if (v === null || v === undefined) {
				return '';
			}
			const s = String(v);
			return s.length > 100 ? s.slice(0, 100) + '...' : s;
		});
		lines.push(`| ${values.join(' | ')} |`);
	}

	if (truncated) {
		lines.push('');
		lines.push('⚠️ Results were truncated. Add a LIMIT clause or narrow your query.');
	}

	return lines.join('\n');
}

/**
 * Simple LanguageModelToolResult implementation.
 */
class LanguageModelToolResultImpl {
	constructor(public readonly content: (vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart)[]) { }
}

ToolRegistry.registerTool(SessionStoreSqlTool);
