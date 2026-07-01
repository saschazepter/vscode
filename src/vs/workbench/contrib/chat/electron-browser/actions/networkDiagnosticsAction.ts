/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../../nls.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { IAgentHostHttpFetchResult, IAgentHostService, AgentHostEnabledSettingId } from '../../../../../platform/agentHost/common/agentService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

/**
 * Developer action that exercises the agent runtime's own networking stack via
 * `IAgentHostService.runtimeDiagnosticsHttpFetch`, probing a small set of
 * GitHub/Copilot endpoints and writing a report to an untitled editor. The
 * fetch runs inside the agent host process, so it reflects the exact proxy / CA
 * / address handling the Copilot agent uses for its own traffic.
 */
export class NetworkDiagnosticsAction extends Action2 {
	static readonly ID = 'workbench.action.chat.networkDiagnostics';

	constructor() {
		super({
			id: NetworkDiagnosticsAction.ID,
			title: localize2('networkDiagnostics', "Network Diagnostics"),
			category: Categories.Developer,
			f1: true,
			icon: Codicon.globe,
			precondition: ContextKeyExpr.and(
				ChatContextKeys.enabled,
				ContextKeyExpr.equals(`config.${AgentHostEnabledSettingId}`, true),
			),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const agentHostService = accessor.get(IAgentHostService);
		const editorService = accessor.get(IEditorService);
		const productService = accessor.get(IProductService);

		const urls = this._probeUrls(productService);

		const lines: string[] = [
			`# Copilot Network Diagnostics`,
			``,
			`Requests are issued through the agent runtime's own networking stack`,
			`(\`runtime.diagnostics.httpFetch\`), reflecting the proxy / CA / address`,
			`handling the Copilot agent uses for its own traffic.`,
			``,
		];

		for (const url of urls) {
			lines.push(`## ${url}`, ``);
			const start = Date.now();
			try {
				const result = await agentHostService.runtimeDiagnosticsHttpFetch({ url, method: 'GET' });
				lines.push(...this._formatResult(result));
			} catch (err) {
				lines.push(`- Error (${Date.now() - start} ms): ${toErrorMessage(err)}`);
			}
			lines.push(``);
		}

		await editorService.openEditor({
			resource: undefined,
			contents: lines.join('\n'),
			languageId: 'markdown',
			options: { pinned: true },
		});
	}

	private _probeUrls(productService: IProductService): string[] {
		const candidates: (string | undefined)[] = [
			// productService.defaultChatAgent?.entitlementUrl,
			// productService.defaultChatAgent?.tokenEntitlementUrl,
			// productService.defaultChatAgent?.managedSettingsUrl,
		];
		const urls = new Set<string>();
		for (const candidate of candidates) {
			if (candidate) {
				urls.add(candidate);
			}
		}
		// Fall back to the public GitHub API root if product data is unavailable.
		if (urls.size === 0) {
			urls.add('https://api.github.com/');
		}
		return [...urls];
	}

	private _formatResult(result: IAgentHostHttpFetchResult): string[] {
		const lines = [
			`- HTTP ${result.status} ${result.statusText} (${Math.round(result.durationMs)} ms)`,
		];
		if (result.proxyType) {
			lines.push(`- Proxy: ${result.proxyType} (auth: ${result.proxyAuthType ?? 'unknown'})`);
		} else {
			lines.push(`- Proxy: none (direct)`);
		}
		if (result.url && result.url !== '') {
			lines.push(`- Final URL: ${result.url}`);
		}
		return lines;
	}
}
