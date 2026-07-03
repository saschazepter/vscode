/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { getExtensionTarget, getPlatformSpecificAssetName } from '../extensionTarget.ts';

suite('extensionTarget', () => {
	test('getExtensionTarget resolves marketplace target platforms', () => {
		const notAlpine = () => false;
		const alpine = () => true;

		assert.deepStrictEqual({
			darwinX64: getExtensionTarget('darwin', 'x64'),
			darwinArm64: getExtensionTarget('darwin', 'arm64'),
			win32X64: getExtensionTarget('win32', 'x64'),
			win32Arm64: getExtensionTarget('win32', 'arm64'),
			win32Ia32: getExtensionTarget('win32', 'ia32'),
			linuxX64: getExtensionTarget('linux', 'x64', notAlpine),
			linuxArm64: getExtensionTarget('linux', 'arm64', notAlpine),
			linuxArmhf: getExtensionTarget('linux', 'armhf', notAlpine),
			linuxArmProcess: getExtensionTarget('linux', 'arm', notAlpine),
			alpineX64: getExtensionTarget('linux', 'x64', alpine),
			alpineArm64: getExtensionTarget('linux', 'arm64', alpine),
			unsupported: getExtensionTarget('sunos', 'x64'),
		}, {
			darwinX64: 'darwin-x64',
			darwinArm64: 'darwin-arm64',
			win32X64: 'win32-x64',
			win32Arm64: 'win32-arm64',
			win32Ia32: 'win32-x86',
			linuxX64: 'linux-x64',
			linuxArm64: 'linux-arm64',
			linuxArmhf: 'linux-armhf',
			linuxArmProcess: 'linux-armhf',
			alpineX64: 'alpine-x64',
			alpineArm64: 'alpine-arm64',
			unsupported: undefined,
		});
	});

	test('getPlatformSpecificAssetName follows the node-vsce-sign naming pattern', () => {
		assert.deepStrictEqual({
			darwinX64: getPlatformSpecificAssetName('my-ext', 'darwin-x64'),
			darwinArm64: getPlatformSpecificAssetName('my-ext', 'darwin-arm64'),
			win32X64: getPlatformSpecificAssetName('my-ext', 'win32-x64'),
			win32Arm64: getPlatformSpecificAssetName('my-ext', 'win32-arm64'),
			linuxX64: getPlatformSpecificAssetName('my-ext', 'linux-x64'),
			linuxArm64: getPlatformSpecificAssetName('my-ext', 'linux-arm64'),
			linuxArmhf: getPlatformSpecificAssetName('my-ext', 'linux-armhf'),
			alpineX64: getPlatformSpecificAssetName('my-ext', 'alpine-x64'),
			alpineArm64: getPlatformSpecificAssetName('my-ext', 'alpine-arm64'),
		}, {
			darwinX64: 'my-ext-osx-x64.vsix',
			darwinArm64: 'my-ext-osx-arm64.vsix',
			win32X64: 'my-ext-win-x64.vsix',
			win32Arm64: 'my-ext-win-arm64.vsix',
			linuxX64: 'my-ext-linux-x64.vsix',
			linuxArm64: 'my-ext-linux-arm64.vsix',
			linuxArmhf: 'my-ext-linux-arm.vsix',
			alpineX64: 'my-ext-alpine-x64.vsix',
			alpineArm64: 'my-ext-alpine-arm64.vsix',
		});
	});
});
