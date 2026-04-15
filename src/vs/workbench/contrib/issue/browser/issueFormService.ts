/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { safeSetInnerHtml } from '../../../../base/browser/domSanitize.js';
import { createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { getMenuWidgetCSS, Menu, unthemedMenuStyles } from '../../../../base/browser/ui/menu/menu.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { isLinux, isWindows } from '../../../../base/common/platform.js';
import Severity from '../../../../base/common/severity.js';
import { localize } from '../../../../nls.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier, ExtensionIdentifierSet } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import product from '../../../../platform/product/common/product.js';
import { IRectangle } from '../../../../platform/window/common/window.js';
import { AuxiliaryWindowMode, IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IIssueFormService, IssueReporterData } from '../common/issue.js';
import { IssueReporterOverlay } from './issueReporterOverlay.js';
import BaseHtml from './issueReporterPage.js';
import { IssueWebReporter } from './issueReporterService.js';
import { IRecordingService } from './recordingService.js';
import { IScreenshotService } from './screenshotService.js';
import { IGitHubUploadService } from './githubUploadService.js';
import { IssueReporterEditorInput } from './issueReporterEditorInput.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import './media/issueReporter.css';

export interface IssuePassData {
	issueTitle: string;
	issueBody: string;
}

export class IssueFormService implements IIssueFormService {

	readonly _serviceBrand: undefined;

	protected currentData: IssueReporterData | undefined;

	protected issueReporterWindow: Window | null = null;
	protected extensionIdentifierSet: ExtensionIdentifierSet = new ExtensionIdentifierSet();

	protected arch: string = '';
	protected release: string = '';
	protected type: string = '';

	constructor(
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IAuxiliaryWindowService protected readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@IMenuService protected readonly menuService: IMenuService,
		@IContextKeyService protected readonly contextKeyService: IContextKeyService,
		@ILogService protected readonly logService: ILogService,
		@IDialogService protected readonly dialogService: IDialogService,
		@IHostService protected readonly hostService: IHostService,
		@ILayoutService protected readonly layoutService: ILayoutService,
		@IScreenshotService protected readonly screenshotService: IScreenshotService,
		@IOpenerService protected readonly openerService: IOpenerService,
		@IRecordingService protected readonly recordingService: IRecordingService,
		@IFileDialogService protected readonly fileDialogService: IFileDialogService,
		@IFileService protected readonly fileService: IFileService,
		@IEnvironmentService protected readonly environmentService: IEnvironmentService,
		@IGitHubUploadService protected readonly githubUploadService: IGitHubUploadService,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
		@IEditorService protected readonly editorService: IEditorService,
	) { }

	async openReporter(data: IssueReporterData): Promise<void> {
		if (this.hasToReload(data)) {
			return;
		}

		const wizardConfig = this.configurationService.getValue<{ enabled?: boolean }>('issueReporter.experimental.issueReportingWizard');
		const useWizard = wizardConfig?.enabled ?? false;
		if (!useWizard) {
			this.openAuxIssueReporterLegacy(data);
			return;
		}

		this.openEditorTabReporter(data);
	}

	protected openEditorTabReporter(data: IssueReporterData): void {
		const input = this.instantiationService.createInstance(IssueReporterEditorInput, data);
		this.editorService.openEditor(input);
	}

	async submitIssue(wizard: IssueReporterOverlay, data: IssueReporterData, title: string, body: string): Promise<void> {
		const screenshots = wizard.getScreenshots();
		const recordings = wizard.getRecordings();

		// Determine the issue URL
		let issueUrl = data.privateUri
			? URI.revive(data.privateUri).toString()
			: product.reportIssueUrl ?? '';

		const selectedExtension = data.extensionId
			? data.enabledExtensions.find(ext => ext.id.toLocaleLowerCase() === data.extensionId?.toLocaleLowerCase())
			: undefined;

		if (selectedExtension?.uri) {
			issueUrl = URI.revive(selectedExtension.uri).toString();
		}

		let mediaMarkdown = '';
		const hasAttachments = screenshots.length > 0 || recordings.length > 0;

		if (hasAttachments && data.githubAccessToken) {
			this.logService.info(`[IssueFormService] Mobile API upload: ${screenshots.length} screenshots, ${recordings.length} recordings`);

			wizard.setUploading(true);

			try {
				const repoId = await this.githubUploadService.resolveRepositoryId('microsoft', 'vscode');

				const filesToUpload: { name: string; bytes: Uint8Array; contentType: string }[] = [];
				for (let i = 0; i < screenshots.length; i++) {
					const bytes = this.dataUrlToBytes(screenshots[i].annotatedDataUrl ?? screenshots[i].dataUrl);
					if (bytes) {
						filesToUpload.push({ name: `screenshot-${i + 1}.png`, bytes, contentType: 'image/png' });
					}
				}
				for (const rec of recordings) {
					const fileContent = await this.fileService.readFile(URI.file(rec.filePath));
					const ext = rec.filePath.endsWith('.mp4') ? 'mp4' : 'webm';
					const contentType = ext === 'mp4' ? 'video/mp4' : 'video/webm';
					filesToUpload.push({ name: `recording.${ext}`, bytes: fileContent.value.buffer, contentType });
				}

				if (filesToUpload.length > 0) {
					for (let i = 0; i < filesToUpload.length; i++) {
						wizard.setAttachmentUploadState(i, 'pending');
					}

					const uploadResults: import('./githubUploadService.js').IGitHubUploadResult[] = [];
					for (let i = 0; i < filesToUpload.length; i++) {
						wizard.setAttachmentUploadState(i, 'uploading');
						const file = filesToUpload[i];
						const result = await this.githubUploadService.uploadViaMobileApi(
							data.githubAccessToken, repoId, [file]
						);
						uploadResults.push(...result);
						wizard.setAttachmentUploadState(i, 'done');
					}

					mediaMarkdown = '\n\n### Attachments\n\n';
					for (const r of uploadResults) {
						mediaMarkdown += r.contentType.startsWith('video/')
							? `${r.assetUrl}\n\n`
							: `![${r.fileName}](${r.assetUrl})\n\n`;
					}
					this.logService.info(`[IssueFormService] Upload done: ${uploadResults.length} files`);
				}
			} catch (err) {
				this.logService.error('[IssueFormService] Upload failed:', err);
				mediaMarkdown = '\n\n### Attachments\n\n> Upload failed. Please drag and drop attachments manually.\n\n';
			} finally {
				wizard.setUploading(false);
			}
		}

		const issueBody = body + mediaMarkdown;
		this.logService.info(`[IssueFormService] Opening issue preview: bodyLen=${issueBody.length}`);

		let url = `${issueUrl}${issueUrl.indexOf('?') === -1 ? '?' : '&'}title=${encodeURIComponent(title)}&body=${encodeURIComponent(issueBody)}`;

		if (url.length > 7500) {
			const shouldWrite = await this.showClipboardDialog();
			if (!shouldWrite) {
				return;
			}
			url = `${issueUrl}${issueUrl.indexOf('?') === -1 ? '?' : '&'}title=${encodeURIComponent(title)}&body=${encodeURIComponent(localize('pasteData', "We have written the needed data into your clipboard because it was too large to send. Please paste."))}`;
		}

		await this.openerService.open(URI.parse(url));
	}

	private dataUrlToBytes(dataUrl: string): Uint8Array | undefined {
		const commaIndex = dataUrl.indexOf(',');
		if (commaIndex === -1) {
			return undefined;
		}
		const base64 = dataUrl.substring(commaIndex + 1);
		const binaryString = atob(base64);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes;
	}

	/** @deprecated Kept for web fallback when wizard is not enabled. */
	async openAuxIssueReporterLegacy(data: IssueReporterData): Promise<void> {
		await this.openAuxIssueReporter(data);

		if (this.issueReporterWindow) {
			const issueReporter = this.instantiationService.createInstance(IssueWebReporter, false, data, { type: this.type, arch: this.arch, release: this.release }, product, this.issueReporterWindow);
			issueReporter.render();
		}
	}

	async openAuxIssueReporter(data: IssueReporterData, bounds?: IRectangle): Promise<void> {

		let issueReporterBounds: Partial<IRectangle> = { width: 700, height: 800 };

		// Center Issue Reporter Window based on bounds from native host service
		if (bounds && bounds.x && bounds.y) {
			const centerX = bounds.x + bounds.width / 2;
			const centerY = bounds.y + bounds.height / 2;
			issueReporterBounds = { ...issueReporterBounds, x: centerX - 350, y: centerY - 400 };
		}

		const disposables = new DisposableStore();

		// Auxiliary Window
		const auxiliaryWindow = disposables.add(await this.auxiliaryWindowService.open({ mode: AuxiliaryWindowMode.Normal, bounds: issueReporterBounds, nativeTitlebar: true, disableFullscreen: true }));

		const platformClass = isWindows ? 'windows' : isLinux ? 'linux' : 'mac';

		if (auxiliaryWindow) {
			await auxiliaryWindow.whenStylesHaveLoaded;
			auxiliaryWindow.window.document.title = 'Issue Reporter';
			auxiliaryWindow.window.document.body.classList.add('issue-reporter-body', 'monaco-workbench', platformClass);

			// removes preset monaco-workbench container
			auxiliaryWindow.container.remove();

			// The Menu class uses a static globalStyleSheet that's created lazily on first menu creation.
			// Since auxiliary windows clone stylesheets from main window, but Menu.globalStyleSheet
			// may not exist yet in main window, we need to ensure menu styles are available here.
			if (!Menu.globalStyleSheet) {
				const menuStyleSheet = createStyleSheet(auxiliaryWindow.window.document.head);
				menuStyleSheet.textContent = getMenuWidgetCSS(unthemedMenuStyles, false);
			}

			// custom issue reporter wrapper that preserves critical auxiliary window container styles
			const div = document.createElement('div');
			div.classList.add('monaco-workbench');
			auxiliaryWindow.window.document.body.appendChild(div);
			safeSetInnerHtml(div, BaseHtml(), {
				// Also allow input elements
				allowedTags: {
					augment: [
						'input',
						'select',
						'checkbox',
						'textarea',
					]
				},
				allowedAttributes: {
					augment: [
						'id',
						'class',
						'style',
						'textarea',
					]
				}
			});

			this.issueReporterWindow = auxiliaryWindow.window;
		} else {
			console.error('Failed to open auxiliary window');
			disposables.dispose();
		}

		// handle closing issue reporter
		this.issueReporterWindow?.addEventListener('beforeunload', () => {
			auxiliaryWindow.window.close();
			disposables.dispose();
			this.issueReporterWindow = null;
		});
	}

	async sendReporterMenu(extensionId: string): Promise<IssueReporterData | undefined> {
		const menu = this.menuService.createMenu(MenuId.IssueReporter, this.contextKeyService);

		// render menu and dispose
		const actions = menu.getActions({ renderShortTitle: true }).flatMap(entry => entry[1]);
		for (const action of actions) {
			try {
				if (action.item && 'source' in action.item && action.item.source?.id.toLowerCase() === extensionId.toLowerCase()) {
					this.extensionIdentifierSet.add(extensionId.toLowerCase());
					await action.run();
				}
			} catch (error) {
				console.error(error);
			}
		}

		if (!this.extensionIdentifierSet.has(extensionId)) {
			// send undefined to indicate no action was taken
			return undefined;
		}

		// we found the extension, now we clean up the menu and remove it from the set. This is to ensure that we do duplicate extension identifiers
		this.extensionIdentifierSet.delete(new ExtensionIdentifier(extensionId));
		menu.dispose();

		const result = this.currentData;

		// reset current data.
		this.currentData = undefined;

		return result ?? undefined;
	}

	//#region used by issue reporter

	async closeReporter(): Promise<void> {
		this.issueReporterWindow?.close();
	}

	async reloadWithExtensionsDisabled(): Promise<void> {
		if (this.issueReporterWindow) {
			try {
				await this.hostService.reload({ disableExtensions: true });
			} catch (error) {
				this.logService.error(error);
			}
		}
	}

	async showConfirmCloseDialog(): Promise<void> {
		await this.dialogService.prompt({
			type: Severity.Warning,
			message: localize('confirmCloseIssueReporter', "Your input will not be saved. Are you sure you want to close this window?"),
			buttons: [
				{
					label: localize({ key: 'yes', comment: ['&& denotes a mnemonic'] }, "&&Yes"),
					run: () => {
						this.closeReporter();
						this.issueReporterWindow = null;
					}
				},
				{
					label: localize('cancel', "Cancel"),
					run: () => { }
				}
			]
		});
	}

	async showClipboardDialog(): Promise<boolean> {
		let result = false;

		await this.dialogService.prompt({
			type: Severity.Warning,
			message: localize('issueReporterWriteToClipboard', "There is too much data to send to GitHub directly. The data will be copied to the clipboard, please paste it into the GitHub issue page that is opened."),
			buttons: [
				{
					label: localize({ key: 'ok', comment: ['&& denotes a mnemonic'] }, "&&OK"),
					run: () => { result = true; }
				},
				{
					label: localize('cancel', "Cancel"),
					run: () => { result = false; }
				}
			]
		});

		return result;
	}

	hasToReload(data: IssueReporterData): boolean {
		if (data.extensionId && this.extensionIdentifierSet.has(data.extensionId)) {
			this.currentData = data;
			this.issueReporterWindow?.focus();
			return true;
		}

		if (this.issueReporterWindow) {
			this.issueReporterWindow.focus();
			return true;
		}

		return false;
	}
}
