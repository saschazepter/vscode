/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ICopilotTokenManager } from '../../../platform/authentication/common/copilotTokenManager';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';

/** Analytics query path through copilot-api proxy. */
const QUERY_PATH = '/agents/analytics/query';

/** Timeout for analytics query requests (ms). */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Response format from the analytics query API.
 * Data comes as columnar arrays, not row objects.
 */
interface AnalyticsQueryResponse {
	columns: string[];
	column_types: string[];
	data: unknown[][];
	row_count: number;
	truncated: boolean;
}

/**
 * Convert a columnar analytics response to an array of record objects.
 */
function columnarToRecords(response: AnalyticsQueryResponse): Record<string, unknown>[] {
	const { columns, data } = response;
	if (!data || !columns) {
		return [];
	}
	return data.map(row => {
		const record: Record<string, unknown> = {};
		for (let i = 0; i < columns.length; i++) {
			record[columns[i]] = row[i];
		}
		return record;
	});
}

/**
 * HTTP client for querying session data from the cloud analytics API.
 *
 * The endpoint is proxied through copilot-api to the mission-control
 * analytics service, which runs DuckDB for SQL queries.
 * Uses VS Code's ICopilotTokenManager for authentication.
 */
export class CloudSessionStoreClient {

	constructor(
		private readonly _tokenManager: ICopilotTokenManager,
		private readonly _authService: IAuthenticationService,
		private readonly _fetcherService: IFetcherService,
	) { }

	/**
	 * Execute a DuckDB SQL query against the cloud session store (user-scoped).
	 * Returns an array of row objects on success, or undefined on failure.
	 */
	async executeQuery(sql: string): Promise<{ rows: Record<string, unknown>[]; truncated: boolean } | undefined> {
		try {
			const copilotToken = await this._tokenManager.getCopilotToken();
			const baseUrl = copilotToken.endpoints?.api;
			if (!baseUrl) {
				return undefined;
			}

			// The analytics endpoint expects a GitHub OAuth token (like the CLI uses),
			// not the Copilot HMAC proxy token. Try the GitHub session token first.
			const githubToken = this._authService.anyGitHubSession?.accessToken;
			const bearerToken = githubToken ?? copilotToken.token;

			const url = `${baseUrl.replace(/\/+$/, '')}${QUERY_PATH}`;

			const res = await this._fetcherService.fetch(url, {
				callSite: 'chronicle.cloudQuery',
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${bearerToken}`,
					'Copilot-Integration-Id': 'vscode-chat',
				},
				json: { query: sql },
				timeout: REQUEST_TIMEOUT_MS,
			});

			if (!res.ok) {
				return undefined;
			}

			const data = await res.json() as AnalyticsQueryResponse;
			const rows = columnarToRecords(data);
			return { rows, truncated: data.truncated ?? false };
		} catch {
			return undefined;
		}
	}
}
