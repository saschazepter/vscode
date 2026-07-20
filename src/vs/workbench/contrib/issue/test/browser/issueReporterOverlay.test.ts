/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IContextViewDelegate, IContextViewService, IOpenContextView } from '../../../../../platform/contextview/browser/contextView.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractIssueData } from '../../browser/issueFormService.js';
import { IssueReporterOverlay } from '../../browser/issueReporterOverlay.js';
import { RecordingState } from '../../browser/recordingService.js';
import { IssueSource, IssueType } from '../../common/issue.js';

const nesContext = `# Inline Edits Debug Info

## Result:
\`\`\` patch
-const greeting = 'hello';
+const greeting = 'hello world';
\`\`\`

<details><summary>STest</summary>

\`\`\`typescript
stest({ description: 'NES feedback' });
\`\`\`
</details>

<details><summary>Recording</summary>

\`\`\`json
{ "kind": "changed" }
\`\`\`
</details>`;

interface IFakeResizeObserver {
	readonly ctor: typeof ResizeObserver;
	fire(target: Element, width: number, height: number): void;
}

function createFakeResizeObserver(): IFakeResizeObserver {
	let callback: ResizeObserverCallback | undefined;
	let observer: ResizeObserver | undefined;
	class FakeResizeObserver implements ResizeObserver {
		constructor(observerCallback: ResizeObserverCallback) {
			callback = observerCallback;
			observer = this;
		}
		observe(): void { }
		unobserve(): void { }
		disconnect(): void { }
	}
	return {
		ctor: FakeResizeObserver,
		fire: (target, width, height) => {
			if (!callback || !observer) {
				throw new Error('Resize observer not constructed');
			}
			const size: ResizeObserverSize = { inlineSize: width, blockSize: height };
			callback([{
				target,
				borderBoxSize: [size],
				contentBoxSize: [size],
				devicePixelContentBoxSize: [size],
				contentRect: target.getBoundingClientRect(),
			}], observer);
		},
	};
}

function createPointerEvent(type: string, clientX: number, clientY: number): PointerEvent {
	return new PointerEvent(type, { bubbles: true, clientX, clientY });
}

class TestContextViewService implements IContextViewService {
	declare readonly _serviceBrand: undefined;

	private readonly element = document.createElement('div');

	showContextView(delegate: IContextViewDelegate): IOpenContextView {
		const disposable = delegate.render(this.element);
		return {
			close: () => {
				disposable.dispose();
				delegate.onHide?.();
			}
		};
	}

	hideContextView(): void { }

	getContextViewElement(): HTMLElement {
		return this.element;
	}

	layout(): void { }
}

suite('IssueReporterOverlay', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createDragOverlay(recordingSupported = false): {
		overlay: IssueReporterOverlay;
		resizeObserver: IFakeResizeObserver;
		floatingBar: HTMLElement;
		dragArea: HTMLElement;
	} {
		const resizeObserver = createFakeResizeObserver();
		const container = document.createElement('div');
		const overlay = store.add(new IssueReporterOverlay(
			{
				styles: {},
				zoomLevel: 0,
				enabledExtensions: [],
				restrictedMode: false,
				isInstallationPure: true,
				isSessionsWindow: false,
				githubAccessToken: '',
			},
			recordingSupported,
			container,
			new TestContextViewService(),
			undefined,
			undefined,
			true,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			resizeObserver.ctor,
		));
		const floatingBar = mainWindow.document.querySelector<HTMLElement>('.issue-reporter-floating-bar');
		const dragArea = floatingBar?.querySelector<HTMLElement>('.wizard-floating-drag');
		if (!floatingBar || !dragArea) {
			throw new Error('Floating bar not found');
		}
		return { overlay, resizeObserver, floatingBar, dragArea };
	}

	test('includes standalone extension data in a VS Code issue', () => {
		const container = document.createElement('div');
		const overlay = store.add(new IssueReporterOverlay(
			{
				styles: {},
				zoomLevel: 0,
				enabledExtensions: [],
				restrictedMode: false,
				isInstallationPure: true,
				isSessionsWindow: false,
				githubAccessToken: '',
				issueType: IssueType.Bug,
				issueSource: IssueSource.VSCode,
				issueTitle: 'NES feedback',
				issueBody: 'Please describe the expected outcome.',
				data: nesContext,
			},
			false,
			container,
			new TestContextViewService()
		));
		overlay.show();

		const nextButton = container.querySelector<HTMLElement>('.wizard-next');
		if (!nextButton) {
			throw new Error('Next button not found');
		}

		nextButton.click();
		nextButton.click();

		let submission: { title: string; body: string } | undefined;
		store.add(overlay.onDidSubmit(event => submission = event));
		nextButton.click();

		assert.deepStrictEqual(submission && {
			title: submission.title,
			hasExtensionDataSection: submission.body.includes(`<details>
<summary>Extension Data</summary>

${nesContext}

</details>`),
		}, {
			title: 'NES feedback',
			hasExtensionDataSection: true,
		});
	});

	test('extracts nested NES details as one issue data attachment', () => {
		const extensionDataSection = `<details>
<summary>Extension Data</summary>

${nesContext}

</details>`;
		const systemInfoSection = `<details>
<summary>System Info</summary>

|Item|Value|
|---|---|
|OS|Test OS|
</details>`;

		assert.deepStrictEqual(extractIssueData(`### Description

NES feedback

${extensionDataSection}

${systemInfoSection}

<!-- generated by issue reporter -->`), {
			body: `### Description

NES feedback

<!-- generated by issue reporter -->`,
			fileContent: `# Issue Data

${extensionDataSection}

${systemInfoSection}
`,
		});
	});

	test('drags and clamps without measuring geometry on pointer move', () => {
		const { floatingBar, dragArea } = createDragOverlay();
		let geometryReads = 0;
		floatingBar.getBoundingClientRect = () => {
			geometryReads++;
			return DOMRect.fromRect({ x: 100, y: 50, width: 200, height: 40 });
		};

		dragArea.dispatchEvent(createPointerEvent('pointerdown', 110, 60));
		document.dispatchEvent(createPointerEvent('pointermove', mainWindow.innerWidth + 100, mainWindow.innerHeight + 100));
		document.dispatchEvent(createPointerEvent('pointermove', mainWindow.innerWidth + 200, mainWindow.innerHeight + 200));
		document.dispatchEvent(createPointerEvent('pointerup', mainWindow.innerWidth + 200, mainWindow.innerHeight + 200));

		assert.deepStrictEqual({
			left: floatingBar.style.left,
			top: floatingBar.style.top,
			right: floatingBar.style.right,
			geometryReads,
		}, {
			left: `${mainWindow.innerWidth - 200}px`,
			top: `${mainWindow.innerHeight - 40}px`,
			right: 'auto',
			geometryReads: 1,
		});
	});

	test('reclamps a drag when observed bar size grows and shrinks', () => {
		const { resizeObserver, floatingBar, dragArea } = createDragOverlay();
		floatingBar.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 50, width: 200, height: 40 });

		dragArea.dispatchEvent(createPointerEvent('pointerdown', 110, 60));
		document.dispatchEvent(createPointerEvent('pointermove', mainWindow.innerWidth + 100, mainWindow.innerHeight + 100));
		resizeObserver.fire(floatingBar, 300, 60);
		const grownPosition = { left: floatingBar.style.left, top: floatingBar.style.top };
		resizeObserver.fire(floatingBar, 120, 30);
		const shrunkPosition = { left: floatingBar.style.left, top: floatingBar.style.top };
		document.dispatchEvent(createPointerEvent('pointerup', mainWindow.innerWidth + 100, mainWindow.innerHeight + 100));

		assert.deepStrictEqual({ grownPosition, shrunkPosition }, {
			grownPosition: {
				left: `${mainWindow.innerWidth - 300}px`,
				top: `${mainWindow.innerHeight - 60}px`,
			},
			shrunkPosition: {
				left: `${mainWindow.innerWidth - 120}px`,
				top: `${mainWindow.innerHeight - 30}px`,
			},
		});
	});

	test('refreshes drag geometry synchronously when recording state changes', () => {
		const { overlay, floatingBar, dragArea } = createDragOverlay(true);
		let barWidth = 200;
		let barHeight = 40;
		floatingBar.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 50, width: barWidth, height: barHeight });

		dragArea.dispatchEvent(createPointerEvent('pointerdown', 110, 60));
		document.dispatchEvent(createPointerEvent('pointermove', mainWindow.innerWidth + 100, mainWindow.innerHeight + 100));
		barWidth = 300;
		barHeight = 60;
		overlay.setRecordingState(RecordingState.Recording);
		const recordingPosition = { left: floatingBar.style.left, top: floatingBar.style.top };
		barWidth = 120;
		barHeight = 30;
		overlay.setRecordingState(RecordingState.Idle);
		const idlePosition = { left: floatingBar.style.left, top: floatingBar.style.top };
		document.dispatchEvent(createPointerEvent('pointerup', mainWindow.innerWidth + 100, mainWindow.innerHeight + 100));

		assert.deepStrictEqual({ recordingPosition, idlePosition }, {
			recordingPosition: {
				left: `${mainWindow.innerWidth - 300}px`,
				top: `${mainWindow.innerHeight - 60}px`,
			},
			idlePosition: {
				left: `${mainWindow.innerWidth - 120}px`,
				top: `${mainWindow.innerHeight - 30}px`,
			},
		});
	});
});
