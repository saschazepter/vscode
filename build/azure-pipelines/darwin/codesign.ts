/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { printBanner, spawnCodesignProcess, streamProcessOutputAndCheckResult } from '../common/codesign.ts';
import { e } from '../common/publish.ts';

async function main() {
	const arch = e('VSCODE_ARCH');
	const esrpCliDLLPath = e('EsrpCliDllPath');
	const pipelineWorkspace = e('PIPELINE_WORKSPACE');

	const clientFolder = `${pipelineWorkspace}/vscode_client_darwin_${arch}_archive`;
	const dmgFolder = `${pipelineWorkspace}/vscode_client_darwin_${arch}_dmg`;
	const serverFolder = `${pipelineWorkspace}/vscode_server_darwin_${arch}_archive`;
	const webFolder = `${pipelineWorkspace}/vscode_web_darwin_${arch}_archive`;

	const clientGlob = `VSCode-darwin-${arch}.zip`;
	const dmgGlob = `VSCode-darwin-${arch}.dmg`;
	const serverGlob = `vscode-server-darwin-${arch}.zip`;
	const webGlob = `vscode-server-darwin-${arch}-web.zip`;

	// Check if server and web folders exist (they don't exist for universal builds)
	const hasServer = fs.existsSync(serverFolder);
	const hasWeb = fs.existsSync(webFolder);

	// Codesign
	printBanner('Codesign');
	const codesignTasks: Promise<void>[] = [
		streamProcessOutputAndCheckResult('Codesign Client Archive', spawnCodesignProcess(esrpCliDLLPath, 'sign-darwin', clientFolder, clientGlob)),
		streamProcessOutputAndCheckResult('Codesign DMG', spawnCodesignProcess(esrpCliDLLPath, 'sign-darwin', dmgFolder, dmgGlob)),
	];
	if (hasServer) {
		codesignTasks.push(streamProcessOutputAndCheckResult('Codesign Server Archive', spawnCodesignProcess(esrpCliDLLPath, 'sign-darwin', serverFolder, serverGlob)));
	}
	if (hasWeb) {
		codesignTasks.push(streamProcessOutputAndCheckResult('Codesign Web Archive', spawnCodesignProcess(esrpCliDLLPath, 'sign-darwin', webFolder, webGlob)));
	}
	await Promise.all(codesignTasks);

	// Notarize
	printBanner('Notarize');
	const notarizeTasks: Promise<void>[] = [
		streamProcessOutputAndCheckResult('Notarize Client Archive', spawnCodesignProcess(esrpCliDLLPath, 'notarize-darwin', clientFolder, clientGlob)),
		streamProcessOutputAndCheckResult('Notarize DMG', spawnCodesignProcess(esrpCliDLLPath, 'notarize-darwin', dmgFolder, dmgGlob)),
	];
	if (hasServer) {
		notarizeTasks.push(streamProcessOutputAndCheckResult('Notarize Server Archive', spawnCodesignProcess(esrpCliDLLPath, 'notarize-darwin', serverFolder, serverGlob)));
	}
	if (hasWeb) {
		notarizeTasks.push(streamProcessOutputAndCheckResult('Notarize Web Archive', spawnCodesignProcess(esrpCliDLLPath, 'notarize-darwin', webFolder, webGlob)));
	}
	await Promise.all(notarizeTasks);
}

main().then(() => {
	process.exit(0);
}, err => {
	console.error(`ERROR: ${err}`);
	process.exit(1);
});
