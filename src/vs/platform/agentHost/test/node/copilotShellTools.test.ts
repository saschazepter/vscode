/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { Disposable, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { ILogService, NullLogService } from '../../../log/common/log.js';
import type { CreateTerminalParams } from '../../common/state/protocol/commands.js';
import type { TerminalClaim, TerminalInfo } from '../../common/state/protocol/state.js';
import { IAgentHostTerminalManager } from '../../node/agentHostTerminalManager.js';
import { ShellManager, classifyShellExecutable, prefixForHistorySuppression, shellTypeForExecutable } from '../../node/copilot/copilotShellTools.js';

class TestAgentHostTerminalManager implements IAgentHostTerminalManager {
	declare readonly _serviceBrand: undefined;

	defaultShell = '/bin/bash';
	readonly created: { params: CreateTerminalParams; options?: { shell?: string; preventShellHistory?: boolean; nonInteractive?: boolean } }[] = [];

	async createTerminal(params: CreateTerminalParams, options?: { shell?: string; preventShellHistory?: boolean; nonInteractive?: boolean }): Promise<void> {
		this.created.push({ params, options: { ...options, shell: options?.shell ?? this.defaultShell } });
	}
	writeInput(): void { }
	onData(): IDisposable { return Disposable.None; }
	onExit(): IDisposable { return Disposable.None; }
	onClaimChanged(): IDisposable { return Disposable.None; }
	onCommandFinished(): IDisposable { return Disposable.None; }
	getContent(): string | undefined { return undefined; }
	getClaim(): TerminalClaim | undefined { return undefined; }
	hasTerminal(): boolean { return false; }
	getExitCode(): number | undefined { return undefined; }
	supportsCommandDetection(): boolean { return false; }
	disposeTerminal(): void { }
	getTerminalInfos(): TerminalInfo[] { return []; }
	getTerminalState(): undefined { return undefined; }
	async getDefaultShell(): Promise<string> { return this.defaultShell; }
}

suite('CopilotShellTools', () => {

	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	function createServices(): { instantiationService: IInstantiationService; terminalManager: TestAgentHostTerminalManager } {
		const terminalManager = new TestAgentHostTerminalManager();
		const services = new ServiceCollection();
		services.set(ILogService, new NullLogService());
		services.set(IAgentHostTerminalManager, terminalManager);
		const instantiationService: IInstantiationService = disposables.add(new InstantiationService(services));
		services.set(IInstantiationService, instantiationService);
		return { instantiationService, terminalManager };
	}

	test('uses session working directory for created shells', async () => {
		const { instantiationService, terminalManager } = createServices();
		const worktreePath = URI.file('/workspace/worktree').fsPath;
		const explicitCwd = URI.file('/explicit/cwd').fsPath;
		const shellManager = disposables.add(instantiationService.createInstance(ShellManager, URI.parse('copilot:/session-1'), URI.file(worktreePath)));

		await shellManager.getOrCreateShell('bash', 'turn-1', 'tool-1');
		await shellManager.getOrCreateShell('bash', 'turn-2', 'tool-2', explicitCwd);

		assert.deepStrictEqual(terminalManager.created.map(c => c.params.cwd), [
			worktreePath,
			explicitCwd,
		]);
	});

	test('opts every managed shell into shell-history suppression and non-interactive mode', async () => {
		const { instantiationService, terminalManager } = createServices();
		const shellManager = disposables.add(instantiationService.createInstance(ShellManager, URI.parse('copilot:/session-1'), undefined));

		await shellManager.getOrCreateShell('bash', 'turn-1', 'tool-1');

		assert.strictEqual(terminalManager.created.length, 1);
		assert.strictEqual(terminalManager.created[0].options?.preventShellHistory, true);
		assert.strictEqual(terminalManager.created[0].options?.nonInteractive, true);
	});

	test('uses the executable resolved by the terminal manager', async () => {
		const { instantiationService, terminalManager } = createServices();
		terminalManager.defaultShell = '/custom/path/to/pwsh';
		const shellManager = disposables.add(instantiationService.createInstance(ShellManager, URI.parse('copilot:/session-1'), undefined));

		await shellManager.getOrCreateShell('powershell', 'turn-1', 'tool-1');

		assert.strictEqual(terminalManager.created[0].options?.shell, '/custom/path/to/pwsh');
	});

	test('prefixForHistorySuppression prepends a space for POSIX shells, no-op for PowerShell', () => {
		assert.strictEqual(prefixForHistorySuppression('bash'), ' ');
		assert.strictEqual(prefixForHistorySuppression('powershell'), '');
	});

	test('classifyShellExecutable maps known shell basenames to a shell type', () => {
		assert.deepStrictEqual([
			classifyShellExecutable('C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
			classifyShellExecutable('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
			classifyShellExecutable('/usr/bin/bash'),
			classifyShellExecutable('/usr/bin/zsh'),
			classifyShellExecutable('/bin/sh'),
			classifyShellExecutable('C:\\Windows\\System32\\cmd.exe'),
		], ['powershell', 'powershell', 'bash', 'bash', 'bash', undefined]);
	});

	test('shellTypeForExecutable falls back to platform default for unknown shells', () => {
		const unknownDefault = shellTypeForExecutable('C:\\Windows\\System32\\cmd.exe');
		// Falls back to platform default; just assert it's one of the known types.
		assert.ok(unknownDefault === 'bash' || unknownDefault === 'powershell');
	});
});
