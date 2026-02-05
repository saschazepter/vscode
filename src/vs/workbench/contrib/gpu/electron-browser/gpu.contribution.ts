/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';

class ElectronGpuUnsupportedContribution {
	static readonly ID = 'workbench.contrib.electronGpuUnsupported';

	constructor() {
		try {
			const disabledViaArg = ElectronGpuUnsupportedContribution.isGpuDisabledViaArgs();
			const webglSupported = GpuCheck.isWebGlGood();
			const softwareRenderer = GpuCheck.isSoftwareRenderer();

			console.info('[gpu][electron] disabledViaArg=', disabledViaArg, 'webglSupported=', webglSupported, 'softwareRenderer=', softwareRenderer);

			const unsupported = disabledViaArg || !webglSupported || softwareRenderer;
			const applyToWorkbench = () => {
				const wb = mainWindow.document.body.parentElement;
				if (wb && wb.classList.contains('monaco-workbench')) {
					if (unsupported) {
						console.info('[gpu][electron] Adding class gpu-unsupported to workbench element');
						wb.classList.add('gpu-unsupported');
					}
					return true;
				}
				return false;
			};

			if (!applyToWorkbench()) {
				if (unsupported) {
					console.info('[gpu][electron] workbench not present yet -- adding gpu-unsupported to documentElement as fallback');
					mainWindow.document.documentElement.classList.add('gpu-unsupported');
				}

				const observer = new MutationObserver((_, obs) => {
					if (applyToWorkbench()) {
						mainWindow.document.documentElement.classList.remove('gpu-unsupported');
						obs.disconnect();
					}
				});
				observer.observe(mainWindow.document.documentElement, { childList: true, subtree: true });

				mainWindow.addEventListener('DOMContentLoaded', () => {
					if (applyToWorkbench()) {
						mainWindow.document.documentElement.classList.remove('gpu-unsupported');
					}
					observer.disconnect();
				}, { once: true });
			}
		} catch (e) {
			console.error('[gpu][electron] error while detecting GPU/support', e);
		}
	}

	private static isGpuDisabledViaArgs(): boolean {
		try {
			// In Electron renderer, `process` may be exposed in a sandbox. Try to read args.
			// Look for common flags that disable GPU.
			const anyWin = mainWindow as unknown as { process?: { argv?: string[] }; require?: (mod: string) => unknown };
			const argv: string[] | undefined = anyWin?.process?.argv || (anyWin?.require && (anyWin.require('electron') as { remote?: { process?: { argv?: string[] } } })?.remote?.process?.argv);
			if (argv && Array.isArray(argv)) {
				return argv.some(a => /--disable-gpu|--disable-gpu-compositing|--disable-software-rasterizer/i.test(a));
			}
		} catch (e) {
			// ignore
		}
		return false;
	}
}

class GpuCheck {
	static isWebGlGood(): boolean {
		try {
			const canvas = mainWindow.document.createElement('canvas');
			const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
			return !!gl;
		} catch {
			return false;
		}
	}

	static isSoftwareRenderer(): boolean {
		try {
			const canvas = mainWindow.document.createElement('canvas');
			const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
			if (!gl) {
				return false;
			}
			const dbg = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
			if (dbg) {
				const renderer = (gl as WebGLRenderingContext).getParameter((dbg as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL) || '';
				return /swiftshader|llvmpipe|software rasterizer|softpipe|mesa/i.test(renderer);
			}
		} catch {
			// ignore
		}
		return false;
	}
}

registerWorkbenchContribution2(ElectronGpuUnsupportedContribution.ID, ElectronGpuUnsupportedContribution, WorkbenchPhase.BlockStartup);
