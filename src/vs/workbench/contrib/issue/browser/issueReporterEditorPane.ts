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
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IssueReporterEditorInput } from './issueReporterEditorInput.js';
import { IssueReporterOverlay } from './issueReporterOverlay.js';
import { IRecordingService, IRecordingData, RecordingState } from './recordingService.js';
import { IScreenshotService } from './screenshotService.js';
import { IIssueFormService } from '../common/issue.js';
import { IssueFormService } from './issueFormService.js';
import { IProcessService } from '../../../../platform/process/common/process.js';
import { IWorkbenchAssignmentService } from '../../../services/assignment/common/assignmentService.js';
import product from '../../../../platform/product/common/product.js';
import { isLinuxSnap } from '../../../../base/common/platform.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';

/**
 * Editor pane that hosts the issue reporter wizard inside an editor tab.
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
		@IRecordingService private readonly recordingService: IRecordingService,
		@IScreenshotService private readonly screenshotService: IScreenshotService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IEditorService private readonly editorService: IEditorService,
		@IIssueFormService private readonly issueFormService: IIssueFormService,
		@IProcessService private readonly processService: IProcessService,
		@IWorkbenchAssignmentService private readonly experimentService: IWorkbenchAssignmentService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
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

		// Create the wizard — renders inside this container
		this.wizard = new IssueReporterOverlay(
			data,
			this.recordingService.isSupported,
			this.container,
			this.contextMenuService,
		);
		this.inputDisposables.add(this.wizard);

		// Let the input check wizard state for close confirmation
		input.hasUserInputFn = () => this.wizard?.hasUnsavedChanges() ?? false;

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

		// Populate system info in background (non-blocking)
		this.populateSystemInfo();

		// Wire screenshot capture
		this.inputDisposables.add(this.wizard.onDidRequestScreenshot(async () => {
			try {
				// Hide the floating bar so it doesn't appear in the screenshot
				this.wizard?.hideFloatingBar();

				// Small delay to let the bar disappear before capture
				await new Promise(r => setTimeout(r, 100));

				const dataUrl = await this.screenshotService.captureScreenshot();

				// Keep bar hidden for a moment — the annotation editor opens anyway
				setTimeout(() => this.wizard?.showFloatingBar(), 1000);

				if (!dataUrl || !this.wizard) {
					return;
				}

				const img = await new Promise<HTMLImageElement>((resolve, reject) => {
					const image = new Image();
					image.onload = () => resolve(image);
					image.onerror = reject;
					image.src = dataUrl;
				});

				this.wizard.addScreenshot({ dataUrl, width: img.naturalWidth, height: img.naturalHeight });
			} catch (err) {
				setTimeout(() => this.wizard?.showFloatingBar(), 1000);
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

		// Wire open screenshot — save to temp file and open in editor
		this.inputDisposables.add(this.wizard.onDidRequestOpenScreenshot(async (screenshot) => {
			try {
				const dataUrl = screenshot.annotatedDataUrl ?? screenshot.dataUrl;
				const commaIndex = dataUrl.indexOf(',');
				if (commaIndex === -1) {
					return;
				}
				const base64 = dataUrl.substring(commaIndex + 1);
				const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
				const fileName = `screenshot-${Date.now()}.jpg`;
				const target = URI.joinPath(this.environmentService.userRoamingDataHome, 'issue-recordings', fileName);
				await this.fileService.writeFile(target, VSBuffer.wrap(bytes));
				await this.editorService.openEditor({ resource: target });
			} catch (err) {
				this.logService.error('[IssueReporterEditorPane] Open screenshot failed:', err);
			}
		}));

		// Wire open recording — open file in editor
		this.inputDisposables.add(this.wizard.onDidRequestOpenRecording(async (filePath) => {
			try {
				await this.editorService.openEditor({ resource: URI.file(filePath) });
			} catch (err) {
				this.logService.error('[IssueReporterEditorPane] Open recording failed:', err);
			}
		}));

		// Wire submit — delegate to form service for upload + open URL
		this.inputDisposables.add(this.wizard.onDidSubmit(async ({ title, body }) => {
			if (!this.wizard) {
				return;
			}
			const opened = await (this.issueFormService as IssueFormService).submitIssue(this.wizard, data, title, body);
			if (opened) {
				// User opened the link — mark as submitted and show close button
				this.wizard.markAsSubmitted();
				this.wizard.showCloseButton();
			}
		}));
	}

	override clearInput(): void {
		// Don't destroy wizard on tab switch — preserve state
		super.clearInput();
	}

	private async populateSystemInfo(): Promise<void> {
		if (!this.wizard) {
			return;
		}

		const input = this.input as IssueReporterEditorInput | undefined;
		const data = input?.data;

		try {
			// Version info
			const osProps = await this.nativeHostService.getOSProperties();
			const vscodeVersion = `${product.nameShort} ${!!product.darwinUniversalAssetId ? `${product.version} (Universal)` : product.version} (${product.commit || 'Commit unknown'}, ${product.date || 'Date unknown'})`;
			const os = `${osProps.type} ${osProps.arch} ${osProps.release}${isLinuxSnap ? ' snap' : ''}`;

			this.wizard.updateModel({
				versionInfo: { vscodeVersion, os },
			});

			// System info (CPUs, GPU, memory, etc.)
			const systemInfo = await this.processService.getSystemInfo();
			this.wizard.updateModel({
				systemInfo,
				systemInfoWeb: navigator.userAgent,
			});
		} catch (err) {
			this.logService.error('[IssueReporterEditorPane] Failed to collect system info:', err);
		}

		// Experiments (independent from system info)
		try {
			const experiments = await this.experimentService.getCurrentExperiments();
			this.wizard?.updateModel({ experimentInfo: experiments?.join('\n') ?? localize('noExperiments', "No current experiments.") });
		} catch {
			// Ignore
		}

		// Extensions — data may have been populated by the issue service's async background task.
		// Give it a moment to finish, then sync.
		await new Promise(r => setTimeout(r, 500));
		if (data && data.enabledExtensions.length > 0) {
			const nonTheme = data.enabledExtensions.filter(e => !e.isTheme && !e.isBuiltin);
			const themeCount = data.enabledExtensions.filter(e => e.isTheme).length;
			this.wizard?.updateModel({
				allExtensions: data.enabledExtensions,
				enabledNonThemeExtesions: nonTheme,
				numberOfThemeExtesions: themeCount,
			});
		}

		// User settings
		try {
			const settingsUri = this.userDataProfileService.currentProfile.settingsResource;
			const settingsContent = await this.fileService.readFile(settingsUri);
			this.wizard?.setSettingsContent(settingsContent.value.toString());
		} catch {
			// Ignore — no settings file
		}
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

			const thumbnailDataUrl = await this.generateVideoThumbnail(data.blob);
			this.wizard?.addRecording(target.fsPath, data.durationMs, thumbnailDataUrl);
		} catch (err) {
			this.logService.error('[IssueReporterEditorPane] Failed to save recording:', err);
		}
	}

	private generateVideoThumbnail(blob: Blob): Promise<string | undefined> {
		return new Promise(resolve => {
			const timeout = setTimeout(() => { cleanup(); resolve(undefined); }, 5000);
			let cleaned = false;
			const cleanup = () => {
				if (cleaned) { return; }
				cleaned = true;
				clearTimeout(timeout);
				URL.revokeObjectURL(url);
				video.remove();
			};

			const url = URL.createObjectURL(blob);
			const video = document.createElement('video');
			video.muted = true;
			video.preload = 'auto';
			video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
			document.body.appendChild(video);
			video.src = url;

			video.addEventListener('loadeddata', () => {
				video.currentTime = Math.min(0.5, video.duration / 2);
			}, { once: true });

			video.addEventListener('seeked', () => {
				try {
					const canvas = document.createElement('canvas');
					canvas.width = video.videoWidth;
					canvas.height = video.videoHeight;
					const ctx = canvas.getContext('2d');
					if (ctx) {
						ctx.drawImage(video, 0, 0);
						cleanup();
						resolve(canvas.toDataURL('image/jpeg', 0.7));
					} else {
						cleanup();
						resolve(undefined);
					}
				} catch {
					cleanup();
					resolve(undefined);
				}
			}, { once: true });

			video.addEventListener('error', () => { cleanup(); resolve(undefined); }, { once: true });
		});
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}
}
