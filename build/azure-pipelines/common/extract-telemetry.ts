/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import cp from 'child_process';
import fs from 'fs';
import path from 'path';

const BUILD_STAGINGDIRECTORY = process.env.BUILD_STAGINGDIRECTORY!;
const BUILD_SOURCESDIRECTORY = process.env.BUILD_SOURCESDIRECTORY!;

const extractionDir = path.join(BUILD_STAGINGDIRECTORY, 'extraction');
fs.mkdirSync(extractionDir, { recursive: true });

const repos = [
	'https://github.com/microsoft/vscode-extension-telemetry.git',
	'https://github.com/microsoft/vscode-chrome-debug-core.git',
	'https://github.com/microsoft/vscode-node-debug2.git',
	'https://github.com/microsoft/vscode-node-debug.git',
	'https://github.com/microsoft/vscode-html-languageservice.git',
	'https://github.com/microsoft/vscode-json-languageservice.git',
];

for (const repo of repos) {
	cp.execSync(`git clone --depth 1 ${repo}`, { cwd: extractionDir, stdio: 'inherit' });
}

const extractor = path.join(BUILD_SOURCESDIRECTORY, 'node_modules', '@vscode', 'telemetry-extractor', 'out', 'extractor.js');
const telemetryConfig = path.join(BUILD_SOURCESDIRECTORY, 'build', 'azure-pipelines', 'common', 'telemetry-config.json');

cp.execSync(`node "${extractor}" --sourceDir "${BUILD_SOURCESDIRECTORY}" --excludedDir "${path.join(BUILD_SOURCESDIRECTORY, 'extensions')}" --outputDir . --applyEndpoints`, { cwd: extractionDir, stdio: 'inherit' });
cp.execSync(`node "${extractor}" --config "${telemetryConfig}" -o .`, { cwd: extractionDir, stdio: 'inherit' });

const telemetryDir = path.join(BUILD_SOURCESDIRECTORY, '.build', 'telemetry');
fs.mkdirSync(telemetryDir, { recursive: true });
fs.renameSync(path.join(extractionDir, 'declarations-resolved.json'), path.join(telemetryDir, 'telemetry-core.json'));
fs.renameSync(path.join(extractionDir, 'config-resolved.json'), path.join(telemetryDir, 'telemetry-extensions.json'));

fs.rmSync(extractionDir, { recursive: true, force: true });
