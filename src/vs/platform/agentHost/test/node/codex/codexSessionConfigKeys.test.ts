/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodexSessionConfigKey, collaborationModeKind, narrowAdditionalDirectories, narrowApprovalPolicy, narrowBoolean, narrowPersonality, narrowReasoningEffort, narrowReasoningSummary, narrowSandboxMode, narrowWebSearchMode } from '../../../node/codex/codexSessionConfigKeys.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IAgentHostGitService } from '../../../common/agentHostGitService.js';
import { ISessionDataService } from '../../../common/sessionDataService.js';
import { CodexAgent } from '../../../node/codex/codexAgent.js';
import { ICodexProxyService } from '../../../node/codex/codexProxyService.js';
import { IAgentConfigurationService } from '../../../node/agentConfigurationService.js';
import { IAgentSdkDownloader } from '../../../node/agentSdkDownloader.js';
import { IAgentBranchNameGenerator } from '../../../node/shared/agentBranchNameGenerator.js';
import { ICopilotApiService } from '../../../node/shared/copilotApiService.js';
import { SessionConfigKey } from '../../../common/sessionConfigKeys.js';
import { createNoopGitService } from '../../common/sessionTestHelpers.js';

function createAgent(disposables: Pick<DisposableStore, 'add'>, gitService?: IAgentHostGitService): CodexAgent {
	const instantiationService = new TestInstantiationService();
	instantiationService.stub(ISessionDataService, { _serviceBrand: undefined });
	instantiationService.stub(ICopilotApiService, { _serviceBrand: undefined });
	instantiationService.stub(ICodexProxyService, { _serviceBrand: undefined });
	instantiationService.stub(IAgentConfigurationService, { _serviceBrand: undefined });
	instantiationService.stub(IAgentSdkDownloader, { _serviceBrand: undefined });
	instantiationService.stub(IAgentHostGitService, gitService ?? createNoopGitService());
	instantiationService.stub(IAgentBranchNameGenerator, { _serviceBrand: undefined, generateBranchName: async () => 'agents/x' });
	instantiationService.stub(IProductService, { _serviceBrand: undefined, version: '1.0.0-test' } as IProductService);
	instantiationService.stub(ILogService, new NullLogService());
	return disposables.add(instantiationService.createInstance(CodexAgent));
}

suite('codexSessionConfigKeys', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('narrows valid values and rejects invalid values', () => {
		assert.deepStrictEqual({
			approvalPolicy: [narrowApprovalPolicy('never'), narrowApprovalPolicy('on-request'), narrowApprovalPolicy('nope')],
			sandboxMode: [narrowSandboxMode('read-only'), narrowSandboxMode('workspace-write'), narrowSandboxMode('folder')],
			additionalDirectories: [narrowAdditionalDirectories(['/tmp/a', '', 1, '/tmp/b']), narrowAdditionalDirectories('nope')],
			boolean: [narrowBoolean(true), narrowBoolean(false), narrowBoolean('true')],
			webSearchMode: [narrowWebSearchMode('disabled'), narrowWebSearchMode('cached'), narrowWebSearchMode('online')],
			reasoningEffort: [narrowReasoningEffort('minimal'), narrowReasoningEffort('medium'), narrowReasoningEffort('max')],
			personality: [narrowPersonality('friendly'), narrowPersonality('pragmatic'), narrowPersonality('grumpy')],
			reasoningSummary: [narrowReasoningSummary('auto'), narrowReasoningSummary('detailed'), narrowReasoningSummary('verbose')],
			collaborationMode: [collaborationModeKind('plan'), collaborationModeKind('interactive'), collaborationModeKind(undefined)],
		}, {
			approvalPolicy: ['never', 'on-request', undefined],
			sandboxMode: ['read-only', 'workspace-write', undefined],
			additionalDirectories: [['/tmp/a', '/tmp/b'], undefined],
			boolean: [true, false, undefined],
			webSearchMode: ['disabled', 'cached', undefined],
			reasoningEffort: ['minimal', 'medium', undefined],
			personality: ['friendly', 'pragmatic', undefined],
			reasoningSummary: ['auto', 'detailed', undefined],
			collaborationMode: ['plan', 'default', 'default'],
		});
	});

	test('resolveSessionConfig scopes Codex-specific config properties', async () => {
		const agent = createAgent(disposables);

		const readOnly = await agent.resolveSessionConfig({ config: { [CodexSessionConfigKey.SandboxMode]: 'read-only' } });
		const workspaceWrite = await agent.resolveSessionConfig({ config: { [CodexSessionConfigKey.SandboxMode]: 'workspace-write' } });

		assert.deepStrictEqual({
			readOnlyProperties: Object.keys(readOnly.schema.properties).filter(key => key.startsWith('codex.')).sort(),
			readOnlyMode: readOnly.values[SessionConfigKey.Mode],
			readOnlyValues: {
				[CodexSessionConfigKey.ApprovalPolicy]: readOnly.values[CodexSessionConfigKey.ApprovalPolicy],
				[CodexSessionConfigKey.SandboxMode]: readOnly.values[CodexSessionConfigKey.SandboxMode],
				[CodexSessionConfigKey.WebSearchMode]: readOnly.values[CodexSessionConfigKey.WebSearchMode],
				[CodexSessionConfigKey.Personality]: readOnly.values[CodexSessionConfigKey.Personality],
				[CodexSessionConfigKey.ReasoningSummary]: readOnly.values[CodexSessionConfigKey.ReasoningSummary],
			},
			workspaceWriteProperties: Object.keys(workspaceWrite.schema.properties).filter(key => key.startsWith('codex.')).sort(),
			workspaceWriteValues: {
				additionalDirectories: workspaceWrite.values[CodexSessionConfigKey.AdditionalDirectories],
				networkAccessEnabled: workspaceWrite.values[CodexSessionConfigKey.NetworkAccessEnabled],
			},
		}, {
			readOnlyProperties: [
				CodexSessionConfigKey.ApprovalPolicy,
				CodexSessionConfigKey.SandboxMode,
				CodexSessionConfigKey.WebSearchMode,
				CodexSessionConfigKey.Personality,
				CodexSessionConfigKey.ReasoningSummary,
			].sort(),
			readOnlyMode: 'interactive',
			readOnlyValues: {
				[CodexSessionConfigKey.ApprovalPolicy]: 'on-request',
				[CodexSessionConfigKey.SandboxMode]: 'read-only',
				[CodexSessionConfigKey.WebSearchMode]: 'disabled',
				[CodexSessionConfigKey.Personality]: 'none',
				[CodexSessionConfigKey.ReasoningSummary]: 'auto',
			},
			workspaceWriteProperties: [
				CodexSessionConfigKey.ApprovalPolicy,
				CodexSessionConfigKey.NetworkAccessEnabled,
				CodexSessionConfigKey.SandboxMode,
				CodexSessionConfigKey.WebSearchMode,
				CodexSessionConfigKey.Personality,
				CodexSessionConfigKey.ReasoningSummary,
			].sort(),
			workspaceWriteValues: {
				additionalDirectories: undefined,
				networkAccessEnabled: false,
			},
		});
	});

	test('resolveSessionConfig returns Codex config without host-owned isolation/branch', async () => {
		// Isolation / branch are contributed by the host (see
		// AgentService._withIsolationSchema), not this agent, so Codex's own
		// resolveSessionConfig exposes only its Codex-specific keys even for a
		// git repository with commits.
		const repoRoot = URI.file('/repo');
		const gitService: IAgentHostGitService = {
			...createNoopGitService(),
			getRepositoryRoot: async () => repoRoot,
			revParse: async (_root, expr) => expr === 'HEAD' ? 'abc123' : undefined,
			getCurrentBranch: async () => 'feature',
			getDefaultBranch: async () => 'main',
		};
		const repoAgent = createAgent(disposables, gitService);
		const repo = await repoAgent.resolveSessionConfig({ workingDirectory: repoRoot });

		assert.deepStrictEqual({
			hasIsolation: repo.schema.properties[SessionConfigKey.Isolation] !== undefined,
			hasBranch: repo.schema.properties[SessionConfigKey.Branch] !== undefined,
			isolationValue: repo.values[SessionConfigKey.Isolation],
			branchValue: repo.values[SessionConfigKey.Branch],
			// The Codex-specific keys are still present.
			codexKeysPresent: repo.schema.properties[CodexSessionConfigKey.SandboxMode] !== undefined,
		}, {
			hasIsolation: false,
			hasBranch: false,
			isolationValue: undefined,
			branchValue: undefined,
			codexKeysPresent: true,
		});
	});
});
