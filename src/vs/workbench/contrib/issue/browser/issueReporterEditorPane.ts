/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/issueReporterOverlay.css';
import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IssueReporterEditorInput } from './issueReporterEditorInput.js';
import { IssueReporterOverlay } from './issueReporterOverlay.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IRecordingService, IRecordingData, RecordingState } from './recordingService.js';
import { IScreenshotService } from './screenshotService.js';

/**
 * Editor pane that hosts the issue reporter wizard inside an editor tab.
 * Used when `issueReporter.experimental.issueReportingWizard.displayMode` is `'tab'`.
 */
export class IssueReporterEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.issueReporter';

	private container: HTMLElement | undefined;
	private wizard: IssueReporterOverlay | undefined;
	private readonly inputDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IRecordingService private readonly recordingService: IRecordingService,
		@IScreenshotService private readonly screenshotService: IScreenshotService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
	) {
		super(IssueReporterEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('div.issue-reporter-editor-tab'));
		this.container.style.height = '100%';
		this.container.style.overflow = 'auto';
	}

	override async setInput(
		input: IssueReporterEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested || !this.container) {
			return;
		}

		// If the wizard is already built and its DOM is still attached, skip recreation
		if (this.wizard && this.container.contains(this.wizard.getPanel())) {
			return;
		}

		this.inputDisposables.clear();
		clearNode(this.container);

		const data = input.data;
		if (!data) {
			const msg = append(this.container, $('p'));
			msg.textContent = localize('noData', "No issue reporter data available.");
			return;
		}

		// Create the wizard in "embedded" mode — renders inside this container
		// instead of inserting itself into document.body as a flex sibling.
		this.wizard = new IssueReporterOverlay(
			data,
			this.layoutService,
			this.recordingService.isSupported,
			{ embedded: true, container: this.container },
		);
		this.inputDisposables.add(this.wizard);

		// Let the input check wizard state for close confirmation
		input.hasUserInputFn = () => this.wizard?.hasUserInput() ?? false;

		// Close the editor tab when the user discards
		this.inputDisposables.add(this.wizard.onDidClose(() => {
			// Reset so close handler doesn't prompt again
			input.hasUserInputFn = undefined;
			this.group.closeEditor(this.input!);
		}));

		// Clean up wizard when the input is disposed (tab actually closed)
		this.inputDisposables.add(input.onWillDispose(() => {
			this.destroyWizard();
		}));

		this.wizard.show();

		// Wire screenshot capture
		this.inputDisposables.add(this.wizard.onDidRequestScreenshot(async () => {
			try {
				const fullDataUrl = await this.screenshotService.captureScreenshot();
				if (!fullDataUrl || !this.wizard) {
					return;
				}

				const fullImg = await new Promise<HTMLImageElement>((resolve, reject) => {
					const img = new Image();
					img.onload = () => resolve(img);
					img.onerror = reject;
					img.src = fullDataUrl;
				});

				// Crop out the capture strip from the top
				const stripHeight = this.wizard.getCaptureStripHeight();
				const dpr = window.devicePixelRatio ?? 1;
				const cropY = Math.round(stripHeight * dpr);
				const cropHeight = fullImg.naturalHeight - cropY;

				if (cropHeight <= 0) {
					this.wizard.addScreenshot({ dataUrl: fullDataUrl, width: fullImg.naturalWidth, height: fullImg.naturalHeight });
					return;
				}

				const canvas = document.createElement('canvas');
				canvas.width = fullImg.naturalWidth;
				canvas.height = cropHeight;
				const ctx = canvas.getContext('2d');
				if (!ctx) {
					return;
				}
				ctx.drawImage(fullImg, 0, cropY, fullImg.naturalWidth, cropHeight, 0, 0, fullImg.naturalWidth, cropHeight);
				const croppedDataUrl = canvas.toDataURL('image/jpeg', 0.95);

				this.wizard.addScreenshot({ dataUrl: croppedDataUrl, width: fullImg.naturalWidth, height: cropHeight });
			} catch (err) {
				this.logService.error('[IssueReporterEditorPane] Screenshot failed:', err);
			}
		}));

		// Wire recording start
		this.inputDisposables.add(this.wizard.onDidRequestStartRecording(async () => {
			try {
				await this.recordingService.startRecording('video/mp4');
				this.wizard?.setRecordingState(RecordingState.Recording);
			} catch (err) {
				this.logService.error('[IssueReporterEditorPane] Recording failed:', err);
				this.wizard?.setRecordingState(RecordingState.Idle);
			}
		}));

		// Wire recording stop
		this.inputDisposables.add(this.wizard.onDidRequestStopRecording(async () => {
			try {
				const recordingData = await this.recordingService.stopRecording();
				if (recordingData) {
					await this.saveRecordingAndAdd(recordingData);
				}
				this.wizard?.setRecordingState(RecordingState.Idle);
			} catch (err) {
				this.logService.error('[IssueReporterEditorPane] Stop recording failed:', err);
				this.wizard?.setRecordingState(RecordingState.Idle);
			}
		}));
	}

	override clearInput(): void {
		// Don't destroy wizard on tab switch — preserve state
		super.clearInput();
	}

	private destroyWizard(): void {
		// Stop any active recording to avoid memory leaks
		if (this.recordingService.state === RecordingState.Recording) {
			this.recordingService.discardRecording();
		}
		this.inputDisposables.clear();
		this.wizard = undefined;
		if (this.container) {
			clearNode(this.container);
		}
	}

	override focus(): void {
		super.focus();
		this.wizard?.focus();
	}

	private async saveRecordingAndAdd(data: IRecordingData): Promise<void> {
		try {
			const extension = data.mimeType.includes('mp4') ? 'mp4' : 'webm';
			const fileName = `vscode-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
			const target = URI.joinPath(this.environmentService.userRoamingDataHome, 'issue-recordings', fileName);

			const arrayBuffer = await data.blob.arrayBuffer();
			await this.fileService.writeFile(target, VSBuffer.wrap(new Uint8Array(arrayBuffer)));
			this.logService.info(`[IssueReporterEditorPane] Recording saved to ${target.toString()}`);

			this.wizard?.addRecording(target.fsPath, data.durationMs);
		} catch (err) {
			this.logService.error('[IssueReporterEditorPane] Failed to save recording:', err);
		}
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}
}
