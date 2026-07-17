/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AgentHostTrackedFile, isDirtyOpenTextModel } from '../../browser/telemetry/agentHostEditSourceTracking.js';

suite('Agent Host Edit Source Tracking', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('flushes current content with the latest language', async () => {
		const disposables = new DisposableStore();
		const resource = URI.file('C:\\repo\\file.ts');
		let currentText = 'alpha';
		const flushes: { resource: URI; content: string; languageId: string; trigger: string }[] = [];
		const trackedFile = disposables.add(new AgentHostTrackedFile(
			resource,
			async () => currentText,
			() => undefined,
			new NullLogService(),
			() => { },
			(flushResource, content, languageId, trigger) => flushes.push({ resource: flushResource, content, languageId, trigger }),
		));

		await trackedFile.applyEdit('typescript');
		await trackedFile.flush('hashChange');
		currentText = 'beta';
		await trackedFile.applyEdit('javascript');
		await trackedFile.flush('branchChange');

		assert.deepStrictEqual(flushes, [
			{ resource, content: 'alpha', languageId: 'typescript', trigger: 'hashChange' },
			{ resource, content: 'beta', languageId: 'javascript', trigger: 'branchChange' },
		]);

		disposables.dispose();
	});

	test('only skips attribution for open dirty text models', () => {
		const resource = URI.file('C:\\repo\\file.ts');
		const model = Object.create(null) as ITextModel;

		assert.deepStrictEqual({
			closedDirty: isDirtyOpenTextModel(resource, { getModel: () => null }, { isDirty: () => true }),
			openClean: isDirtyOpenTextModel(resource, { getModel: () => model }, { isDirty: () => false }),
			openDirty: isDirtyOpenTextModel(resource, { getModel: () => model }, { isDirty: () => true }),
		}, {
			closedDirty: false,
			openClean: false,
			openDirty: true,
		});
	});

	test('uses the transferred resource when flushing a rename', async () => {
		const disposables = new DisposableStore();
		const previousResource = URI.file('C:\\repo\\before.ts');
		const resource = URI.file('C:\\repo\\after.ts');
		const reads: URI[] = [];
		const flushes: URI[] = [];
		const trackedFile = disposables.add(new AgentHostTrackedFile(
			previousResource,
			async currentResource => {
				reads.push(currentResource);
				return 'content';
			},
			() => undefined,
			new NullLogService(),
			() => { },
			currentResource => flushes.push(currentResource),
		));

		trackedFile.setResource(resource);
		await trackedFile.flush('hashChange');

		assert.deepStrictEqual({
			resource: trackedFile.resource,
			reads,
			flushes,
		}, {
			resource,
			reads: [resource],
			flushes: [resource],
		});
		disposables.dispose();
	});
});
