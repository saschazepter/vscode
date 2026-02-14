/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import fs from 'fs';
import minimatch from 'minimatch';
import { makeUniversalApp } from 'vscode-universal-bundler';
import { execSync } from 'child_process';

const root = path.dirname(path.dirname(import.meta.dirname));

async function main(buildDir?: string) {
	const arch = process.env['VSCODE_ARCH'];

	if (!buildDir) {
		throw new Error('Build dir not provided');
	}

	const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
	const appName = product.nameLong + '.app';
	const x64AppPath = path.join(buildDir, 'VSCode-darwin-x64', appName);
	const arm64AppPath = path.join(buildDir, 'VSCode-darwin-arm64', appName);
	const asarRelativePath = path.join('Contents', 'Resources', 'app', 'node_modules.asar');
	const outAppPath = path.join(buildDir, `VSCode-darwin-${arch}`, appName);
	const productJsonPath = path.resolve(outAppPath, 'Contents', 'Resources', 'app', 'product.json');

	// Copilot SDK: each arch build only has its own platform package.
	// Copy the missing one from the other build so the universal merger sees identical file sets.
	const copilotPlatforms = ['darwin-x64', 'darwin-arm64'];
	for (const plat of copilotPlatforms) {
		const relPath = path.join('Contents', 'Resources', 'app', 'node_modules', '@github', `copilot-${plat}`);
		const inX64 = path.join(x64AppPath, relPath);
		const inArm64 = path.join(arm64AppPath, relPath);
		if (fs.existsSync(inX64) && !fs.existsSync(inArm64)) {
			console.log(`Copying missing copilot-${plat} to arm64 build`);
			execSync(`cp -R ${JSON.stringify(inX64)} ${JSON.stringify(inArm64)}`);
		} else if (fs.existsSync(inArm64) && !fs.existsSync(inX64)) {
			console.log(`Copying missing copilot-${plat} to x64 build`);
			execSync(`cp -R ${JSON.stringify(inArm64)} ${JSON.stringify(inX64)}`);
		}
		// Also handle unpacked ASAR copies
		const relPathUnpacked = path.join('Contents', 'Resources', 'app', 'node_modules.asar.unpacked', '@github', `copilot-${plat}`);
		const inX64U = path.join(x64AppPath, relPathUnpacked);
		const inArm64U = path.join(arm64AppPath, relPathUnpacked);
		if (fs.existsSync(inX64U) && !fs.existsSync(inArm64U)) {
			console.log(`Copying missing copilot-${plat} (unpacked) to arm64 build`);
			fs.mkdirSync(path.dirname(inArm64U), { recursive: true });
			execSync(`cp -R ${JSON.stringify(inX64U)} ${JSON.stringify(inArm64U)}`);
		} else if (fs.existsSync(inArm64U) && !fs.existsSync(inX64U)) {
			console.log(`Copying missing copilot-${plat} (unpacked) to x64 build`);
			fs.mkdirSync(path.dirname(inX64U), { recursive: true });
			execSync(`cp -R ${JSON.stringify(inArm64U)} ${JSON.stringify(inX64U)}`);
		}
	}

	const filesToSkip = [
		'**/CodeResources',
		'**/Credits.rtf',
		'**/policies/{*.mobileconfig,**/*.plist}',
		// Copilot SDK platform-specific packages: each arch build only has its own
		// platform package (e.g. x64 has copilot-darwin-x64, arm64 has copilot-darwin-arm64).
		// After the copy step above, both builds have both packages but the
		// binary contents differ (x64 vs arm64 Mach-O). Skip SHA comparison.
		'**/node_modules/@github/copilot-darwin-x64/**',
		'**/node_modules/@github/copilot-darwin-arm64/**',
		'**/node_modules.asar.unpacked/@github/copilot-darwin-x64/**',
		'**/node_modules.asar.unpacked/@github/copilot-darwin-arm64/**',
	];

	await makeUniversalApp({
		x64AppPath,
		arm64AppPath,
		asarPath: asarRelativePath,
		outAppPath,
		force: true,
		mergeASARs: true,
		x64ArchFiles: '{*/kerberos.node,**/extensions/microsoft-authentication/dist/libmsalruntime.dylib,**/extensions/microsoft-authentication/dist/msal-node-runtime.node}',
		filesToSkipComparison: (file: string) => {
			for (const expected of filesToSkip) {
				if (minimatch(file, expected)) {
					return true;
				}
			}
			return false;
		}
	});

	const productJson = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
	Object.assign(productJson, {
		darwinUniversalAssetId: 'darwin-universal'
	});
	fs.writeFileSync(productJsonPath, JSON.stringify(productJson, null, '\t'));
}

if (import.meta.main) {
	main(process.argv[2]).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
