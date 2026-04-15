/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/issueReporterOverlay.css';
import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IssueReporterEditorInput } from './issueReporterEditorInput.js';
import { IssueReporterOverlay } from './issueReporterOverlay.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IRecordingService } from './recordingService.js';

/**
 * Editor pane that hosts the issue reporter wizard inside an editor tab.
 * Used when `issueReporter.experimental.displayMode` is `'tabWithFloatingBar'`.
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
		this.wizard.show();
	}

	override clearInput(): void {
		this.inputDisposables.clear();
		this.wizard = undefined;
		if (this.container) {
			clearNode(this.container);
		}
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this.wizard?.focus();
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}
}
