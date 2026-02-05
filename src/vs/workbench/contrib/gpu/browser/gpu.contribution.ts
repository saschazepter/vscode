/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';

/**
 * Detect whether GPU rendering is available and mark the root element
 * with `gpu-unsupported` when it is not. This allows CSS to provide
 * fallbacks (for example disabling backdrop-filter) on software-rendered
 * environments.
 */
class GpuUnsupportedContribution {
	static readonly ID = 'workbench.contrib.gpuUnsupported';

	constructor() {
		// Skip in Electron -- the electron-browser contribution handles detection there
		const anyWin = mainWindow as unknown as { process?: unknown; require?: unknown };
		if (typeof anyWin.process !== 'undefined' || typeof anyWin.require === 'function') {
			return;
		}

		try {
			const supported = GpuUnsupportedContribution.isGpuAvailable();
			const workbenchEl = mainWindow.document.body.parentElement;
			console.info('[gpu] GpuUnsupportedContribution: supported=', supported, 'workbenchPresent=', !!workbenchEl);

			const applyToWorkbench = () => {
				const wb = mainWindow.document.body.parentElement;
				if (wb && wb.classList.contains('monaco-workbench')) {
					if (!supported) {
						console.info('[gpu] Adding class gpu-unsupported to workbench element');
						wb.classList.add('gpu-unsupported');
					}
					return true;
				}
				return false;
			};

			// If workbench is present now, add class there. Otherwise add to documentElement
			// so styles apply early, then move it when workbench appears.
			if (!applyToWorkbench()) {
				if (!supported) {
					console.info('[gpu] workbench not present yet -- adding gpu-unsupported to documentElement as fallback');
					mainWindow.document.documentElement.classList.add('gpu-unsupported');
				}

				const observer = new MutationObserver((_, obs) => {
					if (applyToWorkbench()) {
						// remove fallback from documentElement
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
			console.error('[gpu] GpuUnsupportedContribution threw', e);
		}
	}

	private static isGpuAvailable(): boolean {
		try {
			const canvas = mainWindow.document.createElement('canvas');
			const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
			if (!gl) {
				console.info('[gpu] WebGL not available');
				return false;
			}

			// If available, check renderer info to detect known software renderers
			const dbg = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
			if (dbg) {
				const renderer = (gl as WebGLRenderingContext).getParameter((dbg as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL) || '';
				console.info('[gpu] WebGL renderer:', renderer);
				if (/swiftshader|llvmpipe|software rasterizer|softpipe|mesa/i.test(renderer)) {
					console.info('[gpu] Detected software WebGL renderer:', renderer);
					return false;
				}
			}

			return true;
		} catch {
			console.info('[gpu] isGpuAvailable threw');
			return false;
		}
	}
}

registerWorkbenchContribution2(GpuUnsupportedContribution.ID, GpuUnsupportedContribution, WorkbenchPhase.BlockStartup);
