/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual } from 'assert';
import { OperatingSystem } from '../../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import type { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { CommandLineMultilineWrapRewriter } from '../../browser/tools/commandLineRewriter/commandLineMultilineWrapRewriter.js';
import type { ICommandLineRewriterOptions } from '../../browser/tools/commandLineRewriter/commandLineRewriter.js';

suite('CommandLineMultilineWrapRewriter', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let instantiationService: TestInstantiationService;
	let rewriter: CommandLineMultilineWrapRewriter;

	function createOptions(command: string, shell: string, os: OperatingSystem): ICommandLineRewriterOptions {
		return {
			commandLine: command,
			cwd: undefined,
			shell,
			os,
		};
	}

	setup(() => {
		instantiationService = workbenchInstantiationService({}, store);
		rewriter = store.add(instantiationService.createInstance(CommandLineMultilineWrapRewriter));
	});

	test('single-line bash command is not rewritten', () => {
		strictEqual(rewriter.rewrite(createOptions('echo hello', '/bin/bash', OperatingSystem.Linux)), undefined);
	});

	test('escaped newline (line continuation) is not treated as multi-line', () => {
		strictEqual(rewriter.rewrite(createOptions('echo foo \\\n  bar', '/bin/bash', OperatingSystem.Linux)), undefined);
	});

	test('Windows is skipped', () => {
		strictEqual(rewriter.rewrite(createOptions('echo a\necho b', 'powershell.exe', OperatingSystem.Windows)), undefined);
	});

	test('PowerShell on POSIX is skipped', () => {
		strictEqual(rewriter.rewrite(createOptions('Write-Host a\nWrite-Host b', 'pwsh', OperatingSystem.Linux)), undefined);
	});

	test('bash: multi-line command is wrapped in <shell> -c', () => {
		deepStrictEqual(
			rewriter.rewrite(createOptions('set -e\napt-get update\napt-get install -y r-base', '/bin/bash', OperatingSystem.Linux)),
			{
				rewritten: `/bin/bash -c 'set -e\napt-get update\napt-get install -y r-base'`,
				reasoning: 'Wrapped multi-line command with `<shell> -c` so shell integration sees a single command',
				forDisplay: 'set -e\napt-get update\napt-get install -y r-base',
			}
		);
	});

	test('zsh: multi-line command is wrapped', () => {
		deepStrictEqual(
			rewriter.rewrite(createOptions('cd /tmp\nls -la', '/bin/zsh', OperatingSystem.Macintosh)),
			{
				rewritten: `/bin/zsh -c 'cd /tmp\nls -la'`,
				reasoning: 'Wrapped multi-line command with `<shell> -c` so shell integration sees a single command',
				forDisplay: 'cd /tmp\nls -la',
			}
		);
	});

	test('bash: single quotes in the command are escaped', () => {
		deepStrictEqual(
			rewriter.rewrite(createOptions(`echo 'a'\necho 'b'`, '/bin/bash', OperatingSystem.Linux)),
			{
				rewritten: `/bin/bash -c 'echo '\\''a'\\''\necho '\\''b'\\'''`,
				reasoning: 'Wrapped multi-line command with `<shell> -c` so shell integration sees a single command',
				forDisplay: `echo 'a'\necho 'b'`,
			}
		);
	});

	test('fish: multi-line command is wrapped with double-quote escaping', () => {
		deepStrictEqual(
			rewriter.rewrite(createOptions('echo "a b"\necho c', '/usr/bin/fish', OperatingSystem.Linux)),
			{
				rewritten: `/usr/bin/fish -c "echo \\"a b\\"\necho c"`,
				reasoning: 'Wrapped multi-line command with `fish -c` so shell integration sees a single command',
				forDisplay: 'echo "a b"\necho c',
			}
		);
	});
});
