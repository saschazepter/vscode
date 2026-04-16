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
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

/** Max rows to return to avoid blowing up the context window. */
const MAX_ROWS = 100;

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
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
	) {
		this._indexingPreference = new SessionIndexingPreference(configService);
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<SessionStoreSqlParams>,
		token: CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		// Strip trailing semicolons — models often append them
		const sql = options.input.query.trim().replace(/;+\s*$/, '');

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

		// Block multiple statements — only one query per call
		if (sql.includes(';')) {
			return new LanguageModelToolResultImpl([
				new LanguageModelTextPart('Error: Only one SQL statement per call. Remove semicolons and split into separate calls.'),
			]);
		}

		// Determine query target based on consent
		const hasCloud = this._indexingPreference.hasCloudConsent();
		console.log(`[Chronicle] SQL tool: hasCloud=${hasCloud}, query=${sql.substring(0, 80)}...`);

		try {
			let rows: Record<string, unknown>[];
			let truncated = false;
			let source: string;
			const startTime = Date.now();

			if (hasCloud) {
				source = 'cloud';
				const client = new CloudSessionStoreClient(this._tokenManager, this._authService, this._fetcherService);
				const result = await client.executeQuery(sql);
				if (!result) {
					this._sendTelemetry(source, 0, Date.now() - startTime, false, 'empty_result');
					return new LanguageModelToolResultImpl([new LanguageModelTextPart('Error: Cloud query returned no result.')]);
				}
				rows = result.rows;
				truncated = result.truncated;
				console.log(`[Chronicle] SQL tool cloud query: ${rows.length} rows`);
			} else {
				source = 'local';
				try {
					rows = this._sessionStore.executeReadOnly(sql);
				} catch (authErr) {
					if (authErr instanceof Error && authErr.message.includes('authorizer')) {
						rows = this._sessionStore.executeReadOnlyFallback(sql);
					} else {
						throw authErr;
					}
				}
				console.log(`[Chronicle] SQL tool local query: ${rows.length} rows`);
			}

			// Cap rows
			if (rows.length > MAX_ROWS) {
				rows = rows.slice(0, MAX_ROWS);
				truncated = true;
			}

			this._sendTelemetry(source, rows.length, Date.now() - startTime, true);

			// Format as table
			const result = formatSqlResult(rows, truncated, source);
			return new LanguageModelToolResultImpl([new LanguageModelTextPart(result)]);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this._sendTelemetry(hasCloud ? 'cloud' : 'local', 0, 0, false, message.substring(0, 100));
			return new LanguageModelToolResultImpl([new LanguageModelTextPart(`Error: ${message}`)]);
		}
	}

	private _sendTelemetry(source: string, rowCount: number, durationMs: number, success: boolean, error?: string): void {
		if (success) {
			/* __GDPR__
				"chronicle.sqlQuery" : {
					"owner": "vijayu",
					"comment": "Tracks session store SQL query execution",
					"source": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Query target: local or cloud." },
					"rowCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of rows returned." },
					"durationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Query duration in milliseconds." }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('chronicle.sqlQuery', {
				source,
			}, {
				rowCount,
				durationMs,
			});
		} else {
			/* __GDPR__
				"chronicle.sqlQuery" : {
					"owner": "vijayu",
					"comment": "Tracks session store SQL query failures",
					"source": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Query target: local or cloud." },
					"error": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "Truncated error message." },
					"rowCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of rows returned." },
					"durationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Query duration in milliseconds." }
				}
			*/
			this._telemetryService.sendMSFTTelemetryErrorEvent('chronicle.sqlQuery', {
				source,
				error: error ?? 'unknown',
			}, {
				rowCount,
				durationMs,
			});
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
