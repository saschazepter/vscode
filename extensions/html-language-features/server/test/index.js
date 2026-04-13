/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import path from 'node:path';
import glob from 'glob';

const testRoot = import.meta.dirname;
const files = glob.sync(path.posix.join(testRoot, '../out/test/**/*.test.js'));

const stream = run({
	files,
	timeout: 60000,
	...(process.env.MOCHA_GREP ? { testNamePatterns: [process.env.MOCHA_GREP] } : {}),
});

let failed = 0;
stream.on('test:fail', () => failed++);
stream.compose(spec).pipe(process.stdout);
stream.on('close', () => process.exit(failed ? 1 : 0));
