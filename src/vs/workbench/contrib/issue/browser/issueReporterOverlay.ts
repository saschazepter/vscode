/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/issueReporterOverlay.css';
import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { Action } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IssueReporterData, IssueType } from '../common/issue.js';
import { IssueReporterModel } from './issueReporterModel.js';
import { RecordingState } from './recordingService.js';
import { ScreenshotAnnotationEditor } from './screenshotAnnotation.js';

const MAX_ATTACHMENTS = 5;

const enum WizardStep {
	Attachments = 0,
	Describe = 1,
	Review = 2,
}

const STEP_COUNT = 3;

export interface IScreenshot {
	readonly dataUrl: string;
	readonly width: number;
	readonly height: number;
	annotatedDataUrl?: string;
}

export class IssueReporterOverlay {

	private readonly disposables = new DisposableStore();
	private readonly _onDidClose = new Emitter<void>();
	readonly onDidClose: Event<void> = this._onDidClose.event;
	private readonly _onDidSubmit = new Emitter<{ title: string; body: string }>();
	readonly onDidSubmit: Event<{ title: string; body: string }> = this._onDidSubmit.event;
	private readonly _onDidRequestScreenshot = new Emitter<void>();
	readonly onDidRequestScreenshot: Event<void> = this._onDidRequestScreenshot.event;
	private readonly _onDidRequestStartRecording = new Emitter<void>();
	readonly onDidRequestStartRecording: Event<void> = this._onDidRequestStartRecording.event;
	private readonly _onDidRequestStopRecording = new Emitter<void>();
	readonly onDidRequestStopRecording: Event<void> = this._onDidRequestStopRecording.event;
	private readonly _onDidRequestOpenRecording = new Emitter<string>();
	readonly onDidRequestOpenRecording: Event<string> = this._onDidRequestOpenRecording.event;
	private readonly _onDidRequestOpenScreenshot = new Emitter<IScreenshot>();
	readonly onDidRequestOpenScreenshot: Event<IScreenshot> = this._onDidRequestOpenScreenshot.event;

	private wizardPanel!: HTMLElement;
	private stepContainer!: HTMLElement;
	private readonly stepPages: HTMLElement[] = [];

	// Step 1: Describe (category + description + title)
	private readonly issueTypeButtons: HTMLElement[] = [];
	private selectedIssueType: IssueType | undefined;
	private typeButtonGroup!: HTMLElement;
	private descriptionTextarea!: HTMLTextAreaElement;
	private descriptionGuidance!: HTMLElement;
	private titleInput!: InputBox;
	private readonly _onDidRequestGenerateTitle = new Emitter<string>();
	readonly onDidRequestGenerateTitle: Event<string> = this._onDidRequestGenerateTitle.event;

	// Step 0: Screenshots & Recording
	private screenshotContainer!: HTMLElement;
	private screenshotDelay = 0;
	private captureBtn!: Button;
	private recordBtn: Button | undefined;
	private recordingElapsedLabel!: HTMLElement;
	private recordingElapsedTimer: ReturnType<typeof setInterval> | undefined;
	private recordingStartTime = 0;
	private currentRecordingState = RecordingState.Idle;
	private delayedScreenshotPending = false;
	private readonly recordings: { filePath: string; durationMs: number; thumbnailDataUrl?: string }[] = [];

	// Step 2: Review
	private reviewThumbCards: HTMLElement[] = [];
	private uploading = false;
	private includeSystemInfo = true;
	private includeExtensions = true;
	private includeExperiments = true;
	private includeSettings = true;
	private settingsContent: string | undefined;
	private workspaceSettingsContent: string | undefined;

	// Navigation
	private stepIndicator!: HTMLElement;
	private stepLabel!: HTMLElement;
	private backButton!: Button;
	private nextButton!: Button;

	// Progress dots
	private readonly progressDots: HTMLElement[] = [];

	private currentStep: WizardStep = WizardStep.Attachments;
	private readonly screenshots: IScreenshot[] = [];
	private readonly model: IssueReporterModel;
	private visible = false;
	private floatingBar: HTMLElement | undefined;
	private submitted = false;

	constructor(
		private readonly data: IssueReporterData,
		private readonly recordingSupported: boolean = false,
		private readonly container: HTMLElement,
		private readonly contextMenuProvider?: IContextMenuProvider,
	) {
		this.model = new IssueReporterModel({
			...data,
			issueType: data.issueType || IssueType.Bug,
			allExtensions: data.enabledExtensions,
			includeSystemInfo: true,
			includeWorkspaceInfo: true,
			includeProcessInfo: true,
			includeExtensions: true,
			includeExperiments: true,
			includeExtensionData: false,
		});
		this.selectedIssueType = data.issueType;

		this.createWizard();
	}

	private createWizard(): void {
		this.wizardPanel = $('div.issue-reporter-wizard');
		this.wizardPanel.setAttribute('role', 'dialog');
		this.wizardPanel.setAttribute('aria-label', localize('reportIssue', "Report Issue"));
		this.wizardPanel.setAttribute('tabindex', '-1');

		// ── Toolbar (drag region + step indicator + discard) ──
		const toolbar = append(this.wizardPanel, $('div.wizard-toolbar'));

		// Progress indicator area
		const progressArea = append(toolbar, $('div.wizard-progress-area'));
		const progressDotsContainer = append(progressArea, $('div.wizard-progress-dots'));
		for (let i = 0; i < STEP_COUNT; i++) {
			const dot = append(progressDotsContainer, $('div.wizard-progress-dot'));
			this.progressDots.push(dot);
		}
		this.stepIndicator = append(progressArea, $('span.wizard-step-indicator'));
		this.stepLabel = append(progressArea, $('span.wizard-step-label'));

		append(toolbar, $('div.spacer'));

		// ── Step content area ──
		this.stepContainer = append(this.wizardPanel, $('div.wizard-step-container'));
		this.createStep0Attachments();
		this.createStep1Describe();
		this.createStep2Review();

		// ── Bottom navigation ──
		const nav = append(this.wizardPanel, $('div.wizard-nav'));

		this.backButton = this.disposables.add(new Button(nav, { ...defaultButtonStyles, secondary: true }));
		this.backButton.label = localize('back', "Back");
		this.backButton.element.classList.add('wizard-back');
		this.backButton.element.title = localize('backEscape', "Back (Escape)");

		this.nextButton = this.disposables.add(new Button(nav, { ...defaultButtonStyles }));
		this.nextButton.label = localize('next', "Next");
		this.nextButton.element.classList.add('wizard-next');
		const ctrlKey = isMacintosh ? '\u2318' : 'Ctrl';
		this.nextButton.element.title = localize('nextCtrlEnter', "Next ({0}+Enter)", ctrlKey);

		this.registerEventHandlers();
		this.updateStepUI();
	}

	// ── Step 0: Attachments ──
	private createStep0Attachments(): void {
		const page = append(this.stepContainer, $('div.wizard-step'));
		this.stepPages.push(page);

		const heading = append(page, $('h2.wizard-heading'));
		heading.textContent = localize('screenshotsHeading', "Add attachments for better context");

		const subtitle = append(page, $('p.wizard-subtitle'));
		subtitle.textContent = localize('screenshotsSubtitle', "You can add up to {0} screenshots or videos. Navigate VS Code and choose when to capture.", MAX_ATTACHMENTS);

		const actions = append(page, $('div.wizard-screenshot-actions'));

		// Delay dropdown
		const delayGroup = append(actions, $('div.wizard-delay-group'));
		const delaySelectLabel = append(delayGroup, $('label.wizard-delay-label'));
		delaySelectLabel.textContent = localize('delayLabel', "Capture delay:");
		const delaySelect = append(delayGroup, $('select.wizard-delay-select')) as HTMLSelectElement;
		const delayOptions = [
			{ label: localize('noDelay', "No delay"), value: 0 },
			{ label: localize('threeSeconds', "3 seconds"), value: 3 },
			{ label: localize('fiveSeconds', "5 seconds"), value: 5 },
			{ label: localize('tenSeconds', "10 seconds"), value: 10 },
		];
		for (const opt of delayOptions) {
			const option = delaySelect.ownerDocument.createElement('option');
			option.value = String(opt.value);
			option.textContent = opt.label;
			delaySelect.appendChild(option);
		}
		this.disposables.add(addDisposableListener(delaySelect, EventType.CHANGE, () => {
			this.screenshotDelay = parseInt(delaySelect.value);
		}));

		this.captureBtn = this.disposables.add(new Button(actions, { ...defaultButtonStyles }));
		this.captureBtn.label = localize('addScreenshot', "Add screenshot");
		this.captureBtn.element.classList.add('wizard-capture-btn');
		const cameraIcon = document.createElement('span');
		cameraIcon.className = 'wizard-capture-icon';
		cameraIcon.appendChild(renderIcon(Codicon.deviceCamera));
		this.captureBtn.element.insertBefore(cameraIcon, this.captureBtn.element.firstChild);

		this.disposables.add(this.captureBtn.onDidClick(() => {
			if (this.getTotalAttachments() >= MAX_ATTACHMENTS || !this.captureBtn.enabled) {
				return;
			}
			if (this.screenshotDelay > 0) {
				this.captureBtn.enabled = false;
				this.delayedScreenshotPending = true;
				this.updateScreenshotThumbnails();
				this.updateAttachmentButtons();
				const origLabel = this.captureBtn.label as string;
				let remaining = this.screenshotDelay;
				this.captureBtn.label = `${remaining}...`;
				const interval = setInterval(() => {
					remaining--;
					if (remaining > 0) {
						this.captureBtn.label = `${remaining}...`;
					} else {
						clearInterval(interval);
						this.captureBtn.label = origLabel;
						this.captureBtn.enabled = true;
						this.delayedScreenshotPending = false;
						this.updateScreenshotThumbnails();
						this.updateAttachmentButtons();
						this._onDidRequestScreenshot.fire();
					}
				}, 1000);
			} else {
				this._onDidRequestScreenshot.fire();
			}
		}));

		// Record video button (only when supported)
		if (this.recordingSupported) {
			this.recordBtn = this.disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			this.recordBtn.label = localize('recordVideo', "Record video");
			this.recordBtn.element.classList.add('wizard-record-btn');
			const recordIcon = document.createElement('span');
			recordIcon.className = 'wizard-record-icon';
			recordIcon.appendChild(renderIcon(Codicon.record));
			this.recordBtn.element.insertBefore(recordIcon, this.recordBtn.element.firstChild);

			this.recordingElapsedLabel = append(this.recordBtn.element, $('span.wizard-recording-elapsed'));
			this.recordingElapsedLabel.style.display = 'none';

			this.disposables.add(this.recordBtn.onDidClick(() => {
				if (this.currentRecordingState === RecordingState.Recording) {
					this._onDidRequestStopRecording.fire();
				} else if (this.currentRecordingState === RecordingState.Idle && this.getTotalAttachments() < MAX_ATTACHMENTS) {
					this._onDidRequestStartRecording.fire();
				}
			}));
		}

		this.screenshotContainer = append(page, $('div.wizard-screenshots'));
		this.updateScreenshotThumbnails();

		// Hide inline actions and use the floating capture bar instead
		actions.style.display = 'none';
		this.createFloatingCaptureBar();
	}

	private captureStripCaptureBtn: HTMLElement | undefined;
	private captureStripDelayBtn: HTMLElement | undefined;
	private captureStripRecordBtn: Button | undefined;

	private createFloatingCaptureBar(): void {
		const targetWindow = getWindow(this.container);
		const body = targetWindow.document.body;

		this.floatingBar = $('div.wizard-floating-bar');

		// Drag handle
		const dragArea = append(this.floatingBar, $('div.wizard-floating-drag'));
		dragArea.appendChild(renderIcon(Codicon.gripper));

		// Segmented screenshot button: [📷 Screenshot | ▾ delay]
		const segmented = append(this.floatingBar, $('div.wizard-segmented-btn'));

		const captureBtn = append(segmented, $('div.wizard-segmented-main.primary'));
		this.captureStripCaptureBtn = captureBtn;
		captureBtn.setAttribute('role', 'button');
		captureBtn.setAttribute('tabindex', '0');
		const cameraIcon = append(captureBtn, $('span'));
		cameraIcon.appendChild(renderIcon(Codicon.deviceCamera));
		const captureLbl = append(captureBtn, $('span'));
		captureLbl.textContent = localize('screenshot', "Screenshot");

		// Delay dropdown using VS Code's DropdownMenu
		const delayOptions = [
			{ label: localize('noDelay', "No delay"), value: 0 },
			{ label: localize('threeSecDelay', "3 second delay"), value: 3 },
			{ label: localize('fiveSecDelay', "5 second delay"), value: 5 },
			{ label: localize('tenSecDelay', "10 second delay"), value: 10 },
		];
		const delayDropdownContainer = append(segmented, $('div.wizard-segmented-dropdown.primary'));
		this.captureStripDelayBtn = delayDropdownContainer;
		delayDropdownContainer.setAttribute('role', 'button');
		delayDropdownContainer.setAttribute('tabindex', '0');
		append(delayDropdownContainer, $('span')).appendChild(renderIcon(Codicon.chevronDown));

		if (this.contextMenuProvider) {
			this.disposables.add(addDisposableListener(delayDropdownContainer, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (delayDropdownContainer.classList.contains('disabled')) {
					return;
				}
				const actions = delayOptions.map(opt => {
					const action = new Action(
						`delay-${opt.value}`,
						opt.label,
						undefined,
						true,
						async () => { this.screenshotDelay = opt.value; }
					);
					action.checked = opt.value === this.screenshotDelay;
					return action;
				});
				this.contextMenuProvider!.showContextMenu({
					getAnchor: () => this.floatingBar!,
					getActions: () => actions,
					skipTelemetry: true,
					onHide: () => { for (const a of actions) { a.dispose(); } },
				});
			}));

			// Close the delay menu when drag starts.
			// The drag handler calls e.preventDefault() on pointerdown which
			// suppresses the mousedown event that the context menu uses for
			// outside-click detection — so we dispatch a synthetic one.
			this.disposables.add(addDisposableListener(dragArea, EventType.POINTER_DOWN, () => {
				dragArea.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			}));
		}

		this.disposables.add(addDisposableListener(captureBtn, EventType.CLICK, () => {
			if (this.getTotalAttachments() < MAX_ATTACHMENTS && !captureBtn.classList.contains('disabled')) {
				if (this.screenshotDelay > 0) {
					// Lock width so button doesn't shrink during countdown
					captureBtn.style.minWidth = `${captureBtn.offsetWidth}px`;
					captureBtn.style.textAlign = 'center';
					captureBtn.classList.add('disabled');
					this.delayedScreenshotPending = true;
					this.updateScreenshotThumbnails();
					this.updateAttachmentButtons();
					let remaining = this.screenshotDelay;
					captureLbl.textContent = `${remaining}...`;
					const interval = setInterval(() => {
						remaining--;
						if (remaining > 0) {
							captureLbl.textContent = `${remaining}...`;
						} else {
							clearInterval(interval);
							captureLbl.textContent = localize('screenshot', "Screenshot");
							captureBtn.classList.remove('disabled');
							captureBtn.style.minWidth = '';
							captureBtn.style.textAlign = '';
							this.delayedScreenshotPending = false;
							this.updateScreenshotThumbnails();
							this.updateAttachmentButtons();
							this._onDidRequestScreenshot.fire();
						}
					}, 1000);
				} else {
					this._onDidRequestScreenshot.fire();
				}
			}
		}));

		// Record button
		if (this.recordingSupported) {
			this.captureStripRecordBtn = this.disposables.add(new Button(this.floatingBar, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
			this.captureStripRecordBtn.label = `$(record) ${localize('recordVideo', "Record video")}`;
			this.captureStripRecordBtn.element.classList.add('wizard-record-btn');
			this.disposables.add(this.captureStripRecordBtn.onDidClick(() => {
				if (this.currentRecordingState === RecordingState.Recording) {
					this._onDidRequestStopRecording.fire();
				} else if (this.currentRecordingState === RecordingState.Idle && this.getTotalAttachments() < MAX_ATTACHMENTS) {
					this._onDidRequestStartRecording.fire();
				}
			}));
		}

		body.appendChild(this.floatingBar);

		// Dragging (clamped to window bounds)
		let dragStartX = 0;
		let dragStartY = 0;
		let barStartX = 0;
		let barStartY = 0;

		const onPointerMove = (e: PointerEvent) => {
			const dx = e.clientX - dragStartX;
			const dy = e.clientY - dragStartY;
			const barW = this.floatingBar!.offsetWidth;
			const barH = this.floatingBar!.offsetHeight;
			const maxX = targetWindow.innerWidth - barW;
			const maxY = targetWindow.innerHeight - barH;
			const newX = Math.max(0, Math.min(barStartX + dx, maxX));
			const newY = Math.max(0, Math.min(barStartY + dy, maxY));
			this.floatingBar!.style.left = `${newX}px`;
			this.floatingBar!.style.top = `${newY}px`;
			this.floatingBar!.style.right = 'auto';
		};

		const onPointerUp = () => {
			dragArea.classList.remove('dragged');
			targetWindow.document.removeEventListener('pointermove', onPointerMove);
			targetWindow.document.removeEventListener('pointerup', onPointerUp);
		};

		this.disposables.add(addDisposableListener(dragArea, EventType.POINTER_DOWN, (e: PointerEvent) => {
			e.preventDefault();
			dragArea.classList.add('dragged');
			dragStartX = e.clientX;
			dragStartY = e.clientY;
			const rect = this.floatingBar!.getBoundingClientRect();
			barStartX = rect.left;
			barStartY = rect.top;
			targetWindow.document.addEventListener('pointermove', onPointerMove);
			targetWindow.document.addEventListener('pointerup', onPointerUp);
		}));

		this.disposables.add(toDisposable(() => {
			this.floatingBar?.remove();
		}));
	}

	private updateCaptureStripVisibility(): void {
		if (!this.floatingBar) {
			return;
		}
		// Show on all steps so the user can capture screenshots of the wizard itself
		this.floatingBar.style.display = '';
	}

	// ── Step 1: Describe (category + description + title) ──
	private createStep1Describe(): void {
		const page = append(this.stepContainer, $('div.wizard-step'));
		this.stepPages.push(page);

		const heading = append(page, $('h2.wizard-heading'));
		heading.textContent = localize('describeHeading', "Describe your feedback");

		// Category selection
		const catLabel = append(page, $('label.wizard-field-label'));
		catLabel.textContent = localize('feedbackCategory', "Category");

		this.typeButtonGroup = append(page, $('div.wizard-type-buttons'));
		const types = [
			{ type: IssueType.Bug, label: localize('bug', "Bug"), icon: Codicon.bug },
			{ type: IssueType.FeatureRequest, label: localize('featureRequest', "Feature Request"), icon: Codicon.lightbulb },
			{ type: IssueType.PerformanceIssue, label: localize('performanceIssue', "Performance Issue"), icon: Codicon.dashboard },
		];

		const selectType = (type: IssueType) => {
			this.selectedIssueType = type;
			this.model.update({ issueType: type });
			this.typeButtonGroup.classList.remove('invalid-input');
			for (const b of this.issueTypeButtons) {
				b.classList.toggle('selected', b.getAttribute('data-type') === String(type));
			}
			this.updateDescriptionGuidance();
		};

		for (const { type, label, icon } of types) {
			const btn = append(this.typeButtonGroup, $('div.wizard-type-btn'));
			btn.setAttribute('role', 'button');
			btn.setAttribute('tabindex', '0');
			btn.setAttribute('data-type', String(type));

			const iconEl = append(btn, $('span.wizard-type-icon'));
			iconEl.appendChild(renderIcon(icon));
			const labelEl = append(btn, $('span'));
			labelEl.textContent = label;

			this.issueTypeButtons.push(btn);
			this.disposables.add(addDisposableListener(btn, EventType.CLICK, () => selectType(type)));
			this.disposables.add(addDisposableListener(btn, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					btn.click();
				}
			}));
		}

		// Number key shortcuts for category selection (1, 2, 3)
		this.disposables.add(addDisposableListener(this.wizardPanel, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (this.currentStep !== WizardStep.Describe) {
				return;
			}
			const index = ['1', '2', '3'].indexOf(e.key);
			if (index >= 0 && index < types.length) {
				// Only when no textarea/input is focused
				const activeEl = this.wizardPanel.ownerDocument.activeElement;
				if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
					return;
				}
				e.preventDefault();
				selectType(types[index].type);
			}
		}));

		// Guidance text (changes based on category)
		this.descriptionGuidance = append(page, $('p.wizard-subtitle.wizard-description-guidance'));
		this.updateDescriptionGuidance();

		// Description textarea
		const descLabel = append(page, $('label.wizard-field-label'));
		descLabel.textContent = localize('description', "Description");
		this.descriptionTextarea = append(page, $('textarea.wizard-textarea')) as HTMLTextAreaElement;
		this.descriptionTextarea.placeholder = localize('descriptionPlaceholder', "Describe the issue in detail...");
		this.descriptionTextarea.rows = 6;
		if (this.data.issueBody) {
			this.descriptionTextarea.value = this.data.issueBody;
		}

		// Title input with AI generate button
		const titleGroup = append(page, $('div.wizard-field.wizard-title-field'));
		const titleLabel = append(titleGroup, $('label.wizard-field-label'));
		titleLabel.textContent = localize('issueTitle', "Title");
		const titleRow = append(titleGroup, $('div.wizard-title-row'));
		this.titleInput = this.disposables.add(new InputBox(titleRow, undefined, {
			placeholder: localize('issueTitlePlaceholder', "Brief summary of the issue"),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		if (this.data.issueTitle) {
			this.titleInput.value = this.data.issueTitle;
		}
		this.disposables.add(this.titleInput.onDidChange(() => {
			this.titleInput.element.classList.remove('invalid-input');
		}));

		const aiBtn = this.disposables.add(new Button(titleRow, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		aiBtn.label = `$(sparkle)`;
		aiBtn.element.classList.add('wizard-ai-title-btn');
		aiBtn.element.title = localize('generateTitle', "Generate title from description");
		this.disposables.add(aiBtn.onDidClick(() => {
			const desc = this.descriptionTextarea.value.trim();
			if (desc) {
				this._onDidRequestGenerateTitle.fire(desc);
			}
		}));
	}

	/** Update the guidance text above the description based on selected category */
	private updateDescriptionGuidance(): void {
		if (!this.descriptionGuidance) {
			return;
		}
		switch (this.selectedIssueType) {
			case IssueType.Bug:
				this.descriptionGuidance.textContent = localize('bugGuidance',
					"Describe what happened, the steps to reproduce, what you expected, and what you observed instead.");
				break;
			case IssueType.FeatureRequest:
				this.descriptionGuidance.textContent = localize('featureGuidance',
					"Describe the feature you'd like to see, what problem it would solve, and any alternatives you've considered.");
				break;
			case IssueType.PerformanceIssue:
				this.descriptionGuidance.textContent = localize('perfGuidance',
					"Describe what is slow, when it happens, whether it's consistent or intermittent, and any patterns you've noticed.");
				break;
			default:
				this.descriptionGuidance.textContent = localize('defaultGuidance',
					"Select a category above, then describe your feedback in detail.");
				break;
		}
	}

	private hasDescriptionContent(): boolean {
		return !!this.descriptionTextarea.value.trim();
	}

	// ── Step 2: Review & Submit ──
	private createStep2Review(): void {
		const page = append(this.stepContainer, $('div.wizard-step.wizard-step-review'));
		this.stepPages.push(page);

		const heading = append(page, $('h2.wizard-heading'));
		heading.textContent = localize('reviewSubmit', "Review and submit");

		// Review details (filled dynamically) — compact horizontal layout
		append(page, $('div.wizard-review-details'));
	}

	private registerEventHandlers(): void {
		// Back
		this.disposables.add(this.backButton.onDidClick(() => this.goBack()));

		// Next
		this.disposables.add(this.nextButton.onDidClick(() => this.goNext()));

		// Ctrl+Enter to advance / submit
		this.disposables.add(addDisposableListener(this.wizardPanel, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				e.stopPropagation();
				this.goNext();
			}
		}));

		// Escape to go back, or close on first step
		this.disposables.add(addDisposableListener(this.wizardPanel, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				if (this.currentStep > WizardStep.Attachments) {
					this.goBack();
				} else {
					this.close();
				}
			}
		}));
	}

	private goBack(): void {
		if (this.submitted) {
			return;
		}
		if (this.currentStep > WizardStep.Attachments) {
			this.setStep(this.currentStep - 1);
		}
	}

	private goNext(): void {
		if (this.submitted && this.currentStep !== WizardStep.Review) {
			return;
		}

		if (this.currentStep === WizardStep.Describe) {
			// Validate: category must be selected
			if (this.selectedIssueType === undefined) {
				this.typeButtonGroup.classList.add('invalid-input');
				return;
			}
			// Validate: description must not be empty
			if (!this.hasDescriptionContent()) {
				this.descriptionTextarea.classList.add('invalid-input');
				return;
			}
			this.descriptionTextarea.classList.remove('invalid-input');
			// Validate: title must not be empty
			const title = this.titleInput.value.trim();
			if (!title) {
				this.titleInput.element.classList.add('invalid-input');
				this.titleInput.focus();
				return;
			}
			this.model.update({ issueDescription: this.descriptionTextarea.value.trim() });
		}

		if (this.currentStep === WizardStep.Review) {
			this.submit();
			return;
		}

		if (this.currentStep < WizardStep.Review) {
			this.setStep(this.currentStep + 1);
		}
	}

	private setStep(step: WizardStep): void {
		const oldStep = this.currentStep;
		this.currentStep = step;

		const oldPage = this.stepPages[oldStep];
		const newPage = this.stepPages[step];

		// Immediate transition — no animation
		oldPage.style.display = 'none';
		newPage.style.display = 'flex';

		this.updateStepUI();

		if (step === WizardStep.Describe) {
			this.descriptionTextarea.focus();
		} else if (step === WizardStep.Review) {
			this.updateReviewDetails();
			this.wizardPanel.focus();
		} else {
			// Attachments — focus the panel so keyboard shortcuts work
			this.wizardPanel.focus();
		}
	}

	private updateStepUI(): void {
		const stepNum = this.currentStep + 1;
		this.stepIndicator.textContent = localize('stepOf', "Step {0} of {1}", stepNum, STEP_COUNT);

		const stepNames = [
			localize('screenshots', "Attachments"),
			localize('composeMessage', "Describe"),
			localize('submit', "Review"),
		];
		this.stepLabel.textContent = `| ${stepNames[this.currentStep]}`;

		// Update progress dots
		for (let i = 0; i < this.progressDots.length; i++) {
			this.progressDots[i].classList.toggle('active', i === this.currentStep);
			this.progressDots[i].classList.toggle('completed', i < this.currentStep);
		}

		// Show/hide pages
		for (let i = 0; i < this.stepPages.length; i++) {
			if (i === this.currentStep) {
				this.stepPages[i].style.display = 'flex';
			} else if (!this.stepPages[i].classList.contains('slide-out-left') && !this.stepPages[i].classList.contains('slide-out-right')) {
				this.stepPages[i].style.display = 'none';
			}
		}

		// Back button visibility
		this.backButton.element.style.display = this.currentStep === WizardStep.Attachments ? 'none' : '';

		// Next button label
		const ctrlKey = isMacintosh ? '\u2318' : 'Ctrl';
		if (this.currentStep === WizardStep.Review) {
			this.nextButton.label = localize('previewOnGitHub', "Preview on GitHub");
			this.nextButton.element.title = localize('submitCtrlEnter', "Preview on GitHub ({0}+Enter)", ctrlKey);
			this.nextButton.enabled = true;
		} else if (this.currentStep === WizardStep.Attachments) {
			this.nextButton.label = this.getTotalAttachments() === 0
				? localize('skip', "Skip")
				: localize('next', "Next");
			this.nextButton.element.title = localize('nextCtrlEnter', "Next ({0}+Enter)", ctrlKey);
		} else {
			this.nextButton.label = localize('next', "Next");
			this.nextButton.element.title = localize('nextCtrlEnter', "Next ({0}+Enter)", ctrlKey);
		}

		// Show/hide capture strip (only on attachments step)
		this.updateCaptureStripVisibility();
		// Reflect recording state on next button
		this.updateNextButtonForRecording();
	}

	private updateReviewDetails(): void {
		const page = this.stepPages[WizardStep.Review];
		const details = page.querySelector('.wizard-review-details');
		if (!details) {
			return;
		}
		details.textContent = '';

		// Title (read-only)
		const titleSection = append(details as HTMLElement, $('div.review-section'));
		const titleLabel = append(titleSection, $('div.review-label'));
		titleLabel.textContent = localize('issueTitle', "Title");
		const titleValue = append(titleSection, $('div.review-value'));
		titleValue.textContent = this.titleInput.value.trim() || localize('noTitle', "(no title)");

		// Category + Description row
		const infoRow = append(details as HTMLElement, $('div.review-info-row'));

		const catSection = append(infoRow, $('div.review-section'));
		const catLabel = append(catSection, $('div.review-label'));
		catLabel.textContent = localize('category', "Category");
		const catValue = append(catSection, $('div.review-value'));
		const typeLabels: Record<number, string> = {
			[IssueType.Bug]: localize('bug', "Bug"),
			[IssueType.FeatureRequest]: localize('featureRequest', "Feature Request"),
			[IssueType.PerformanceIssue]: localize('performanceIssue', "Performance Issue"),
		};
		catValue.textContent = (this.selectedIssueType !== undefined ? typeLabels[this.selectedIssueType] : undefined) ?? localize('unknown', "Unknown");

		const descSection = append(infoRow, $('div.review-section'));
		const descLabel = append(descSection, $('div.review-label'));
		descLabel.textContent = localize('description', "Description");
		const descValue = append(descSection, $('div.review-value.review-description'));
		descValue.textContent = this.descriptionTextarea.value.trim() || localize('noDescription', "(no description)");

		// Attachments row with full-size clickable thumbnails
		const totalAttachments = this.screenshots.length + this.recordings.length;
		if (totalAttachments > 0) {
			const attachSection = append(details as HTMLElement, $('div.review-section'));
			const attachLabel = append(attachSection, $('div.review-label'));
			attachLabel.textContent = localize('attachments', "Attachments ({0})", totalAttachments);
			const thumbRow = append(attachSection, $('div.review-thumbnails'));
			this.reviewThumbCards = [];

			for (let i = 0; i < this.screenshots.length; i++) {
				const s = this.screenshots[i];
				const card = append(thumbRow, $('div.wizard-screenshot-card.review-attachment-card'));
				const img = append(card, $('img')) as HTMLImageElement;
				img.src = s.annotatedDataUrl ?? s.dataUrl;
				img.alt = localize('screenshotAlt', "Screenshot {0}", i + 1);

				// Progress overlay (hidden initially)
				const progressOverlay = append(card, $('div.review-progress-overlay'));
				append(progressOverlay, $('div.review-progress-ring'));

				this.disposables.add(addDisposableListener(card, EventType.CLICK, () => {
					if (!this.uploading) {
						this.openAnnotationEditor(i);
					}
				}));
				this.reviewThumbCards.push(card);
			}

			for (let i = 0; i < this.recordings.length; i++) {
				const rec = this.recordings[i];
				const card = append(thumbRow, $('div.wizard-screenshot-card.wizard-recording-card.review-attachment-card'));
				if (rec.thumbnailDataUrl) {
					const thumbImg = append(card, $('img')) as HTMLImageElement;
					thumbImg.setAttribute('src', rec.thumbnailDataUrl);
					thumbImg.alt = localize('recordingThumbnailAlt', "Recording {0}", i + 1);
					thumbImg.setAttribute('draggable', 'false');
				}
				const playOverlay = append(card, $('div.wizard-recording-play'));
				playOverlay.appendChild(renderIcon(Codicon.play));

				const durSec = Math.floor(rec.durationMs / 1000);
				const durLabel = append(card, $('div.wizard-recording-duration'));
				durLabel.textContent = `${Math.floor(durSec / 60)}:${(durSec % 60).toString().padStart(2, '0')}`;

				// Progress overlay (hidden initially)
				const progressOverlay = append(card, $('div.review-progress-overlay'));
				append(progressOverlay, $('div.review-progress-ring'));

				this.disposables.add(addDisposableListener(card, EventType.CLICK, () => {
					if (!this.uploading) {
						this._onDidRequestOpenRecording.fire(rec.filePath);
					}
				}));
				this.reviewThumbCards.push(card);
			}
		}

		// ── Diagnostic data sections with checkboxes + collapsible details ──
		const diagContainer = append(details as HTMLElement, $('div.review-diagnostics'));

		const modelData = this.model.getData();

		// System Info
		if (modelData.versionInfo || modelData.systemInfo) {
			this.createDiagSection(diagContainer, {
				id: 'system-info',
				label: localize('systemInformation', "System Information"),
				checked: this.includeSystemInfo,
				onToggle: (checked) => {
					this.includeSystemInfo = checked;
					this.model.update({ includeSystemInfo: checked });
				},
				renderContent: (container) => {
					const sysTable = append(container, $('table.review-diag-table'));
					if (modelData.versionInfo) {
						this.addDiagRow(sysTable, 'VS Code', modelData.versionInfo.vscodeVersion);
						this.addDiagRow(sysTable, 'OS', modelData.versionInfo.os);
					}
					if (modelData.systemInfo) {
						this.addDiagRow(sysTable, 'CPUs', modelData.systemInfo.cpus ?? '');
						this.addDiagRow(sysTable, 'Memory', modelData.systemInfo.memory);
						this.addDiagRow(sysTable, 'VM', modelData.systemInfo.vmHint);
						this.addDiagRow(sysTable, 'Screen Reader', modelData.systemInfo.screenReader);
					}
					this.addDiagRow(sysTable, 'User Agent', navigator.userAgent);
					this.addDiagRow(sysTable, 'Installation', modelData.isUnsupported ? 'Unsupported (modified)' : 'Supported (pure)');
					if (modelData.restrictedMode) {
						this.addDiagRow(sysTable, 'Mode', 'Restricted');
					}
				},
			});
		} else {
			const loading = append(diagContainer, $('div.review-diag-loading'));
			loading.textContent = localize('loadingSystemInfo', "Loading system information...");
		}

		// Extensions (non-theme only)
		const nonThemeExtensions = (modelData.allExtensions ?? []).filter(e => !e.isTheme && !e.isBuiltin);
		if (nonThemeExtensions.length > 0) {
			this.createDiagSection(diagContainer, {
				id: 'extensions',
				label: localize('extensions', "Extensions ({0})", nonThemeExtensions.length),
				checked: this.includeExtensions,
				onToggle: (checked) => {
					this.includeExtensions = checked;
					this.model.update({ includeExtensions: checked });
				},
				renderContent: (container) => {
					const extTable = append(container, $('table.review-diag-table.review-ext-table'));
					const header = append(extTable, $('tr'));
					for (const h of ['Name', 'Identifier', 'Author', 'Version']) {
						const th = append(header, $('th.review-ext-th'));
						th.textContent = h;
					}
					for (const ext of nonThemeExtensions) {
						const row = append(extTable, $('tr'));
						append(row, $('td')).textContent = ext.displayName || ext.name;
						append(row, $('td')).textContent = ext.id;
						append(row, $('td')).textContent = ext.publisher ?? '';
						append(row, $('td')).textContent = ext.version;
					}
				},
			});
		}

		// Experiments
		if (modelData.experimentInfo) {
			this.createDiagSection(diagContainer, {
				id: 'experiments',
				label: localize('abExperiments', "A/B Experiments"),
				checked: this.includeExperiments,
				onToggle: (checked) => {
					this.includeExperiments = checked;
					this.model.update({ includeExperiments: checked });
				},
				renderContent: (container) => {
					const pre = append(container, $('pre.review-diag-pre'));
					pre.textContent = modelData.experimentInfo!;
				},
			});
		}

		// Settings
		if (this.settingsContent) {
			this.createDiagSection(diagContainer, {
				id: 'settings',
				label: localize('settings', "Settings"),
				checked: this.includeSettings,
				onToggle: (checked) => {
					this.includeSettings = checked;
				},
				renderContent: (container) => {
					const userLabel = append(container, $('div.review-diag-sublabel'));
					userLabel.textContent = localize('userSettings', "User Settings");
					const userPre = append(container, $('pre.review-diag-pre'));
					userPre.textContent = this.settingsContent!;
					if (this.workspaceSettingsContent) {
						const wsLabel = append(container, $('div.review-diag-sublabel'));
						wsLabel.textContent = localize('workspaceSettings', "Workspace Settings");
						const wsPre = append(container, $('pre.review-diag-pre'));
						wsPre.textContent = this.workspaceSettingsContent;
					}
				},
			});
		}

		// Align all title widths dynamically to the widest title
		const titles = diagContainer.querySelectorAll('.review-diag-title');
		let maxWidth = 0;
		for (const t of titles) {
			(t as HTMLElement).style.minWidth = '';
		}
		for (const t of titles) {
			maxWidth = Math.max(maxWidth, (t as HTMLElement).offsetWidth);
		}
		if (maxWidth > 0) {
			for (const t of titles) {
				(t as HTMLElement).style.minWidth = `${maxWidth}px`;
			}
		}

		// Align all toggle button widths to the widest
		const toggles = diagContainer.querySelectorAll('.review-diag-toggle');
		let maxToggleWidth = 0;
		for (const t of toggles) {
			(t as HTMLElement).style.minWidth = '';
		}
		for (const t of toggles) {
			maxToggleWidth = Math.max(maxToggleWidth, (t as HTMLElement).offsetWidth);
		}
		if (maxToggleWidth > 0) {
			for (const t of toggles) {
				(t as HTMLElement).style.minWidth = `${maxToggleWidth}px`;
			}
		}
	}

	private createDiagSection(parent: HTMLElement, opts: {
		id: string;
		label: string;
		checked: boolean;
		onToggle: (checked: boolean) => void;
		renderContent: (container: HTMLElement) => void;
	}): void {
		const group = append(parent, $('div.review-diag-group'));

		// Header: title | "Include in issue" checkbox | Minimize/Expand button
		const header = append(group, $('div.review-diag-header'));

		const title = append(header, $('span.review-diag-title'));
		title.textContent = opts.label;

		const checkWrap = append(header, $('div.review-diag-check-wrap'));
		const checkbox = this.disposables.add(new Checkbox(localize('includeInIssue', "Include in issue"), opts.checked, defaultCheckboxStyles));
		checkWrap.appendChild(checkbox.domNode);
		const checkLabel = append(checkWrap, $('label.review-diag-check-label'));
		checkLabel.textContent = localize('includeInIssue', "Include in issue");
		this.disposables.add(checkbox.onChange(() => {
			opts.onToggle(checkbox.checked);
		}));

		const toggleBtn = this.disposables.add(new Button(header, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		toggleBtn.label = `$(chevron-up) ${localize('minimize', "Minimize")}`;
		toggleBtn.element.classList.add('review-diag-toggle');

		// Content
		const content = append(group, $('div.review-diag-content'));
		opts.renderContent(content);

		let expanded = true;
		this.disposables.add(toggleBtn.onDidClick(() => {
			expanded = !expanded;
			content.style.display = expanded ? '' : 'none';
			toggleBtn.label = expanded
				? `$(chevron-up) ${localize('minimize', "Minimize")}`
				: `$(chevron-down) ${localize('expand', "Expand")}`;
		}));
	}

	private addDiagRow(table: HTMLElement, label: string, value: string): void {
		const row = append(table, $('tr'));
		const th = append(row, $('td.review-diag-key'));
		th.textContent = label;
		const td = append(row, $('td.review-diag-val'));
		td.textContent = value;
	}

	/** Called by the form service to show upload progress */
	setUploading(uploading: boolean): void {
		this.uploading = uploading;

		if (uploading) {
			this.nextButton.element.classList.add('uploading');
			this.nextButton.label = localize('uploading', "Uploading...");
			this.nextButton.enabled = false;
			this.backButton.element.style.display = 'none';
		} else {
			this.nextButton.element.classList.remove('uploading');
			this.nextButton.label = localize('previewOnGitHub', "Preview on GitHub");
			this.nextButton.enabled = true;
		}
	}

	/** Mark a specific attachment as uploading / done */
	setAttachmentUploadState(index: number, state: 'pending' | 'uploading' | 'done'): void {
		const card = this.reviewThumbCards[index];
		if (!card) {
			return;
		}
		card.classList.remove('upload-pending', 'upload-uploading', 'upload-done');
		card.classList.add(`upload-${state}`);

		const overlay = card.querySelector('.review-progress-overlay') as HTMLElement | null;
		if (!overlay) {
			return;
		}

		if (state === 'done') {
			// Replace ring with checkmark
			overlay.textContent = '';
			const check = document.createElement('span');
			check.className = 'review-progress-check';
			check.appendChild(renderIcon(Codicon.check));
			overlay.appendChild(check);
		}
	}

	private submit(): void {
		const title = this.titleInput.value.trim();
		if (!title) {
			// Should not happen — validated in goNext() on Describe step
			return;
		}

		const description = this.descriptionTextarea.value.trim();
		this.model.update({ issueDescription: description, issueTitle: title, ...(this.selectedIssueType !== undefined ? { issueType: this.selectedIssueType } : {}) });

		const body = this.buildIssueBody();
		this._onDidSubmit.fire({ title, body });
	}

	show(): void {
		if (this.visible) {
			return;
		}
		this.visible = true;

		this.wizardPanel.classList.add('open', 'wizard-embedded');
		this.wizardPanel.style.maxHeight = 'none';
		append(this.container, this.wizardPanel);
		this.wizardPanel.focus();
	}

	close(): void {
		this.visible = false;
		this._onDidClose.fire();
	}

	private getTotalAttachments(): number {
		return this.screenshots.length + this.recordings.length;
	}

	addScreenshot(screenshot: IScreenshot): void {
		if (this.getTotalAttachments() >= MAX_ATTACHMENTS) {
			return;
		}
		this.screenshots.push(screenshot);
		this.updateScreenshotThumbnails();
		this.updateAttachmentButtons();
		this.updateStepUI();

		// Immediately open the annotation editor for the new screenshot
		this.openAnnotationEditor(this.screenshots.length - 1);
	}

	private updateAttachmentButtons(): void {
		const atMax = this.getTotalAttachments() >= MAX_ATTACHMENTS;
		const maxMsg = localize('maxAttachmentsReached', "Max attachments reached");
		const wouldReachMax = this.getTotalAttachments() >= MAX_ATTACHMENTS - 1;

		// Screenshot disabled when: at max, OR recording will fill the last slot, OR delayed screenshot pending
		const screenshotDisabled = atMax || (wouldReachMax && this.currentRecordingState === RecordingState.Recording) || this.delayedScreenshotPending;
		// Record disabled when: at max, OR delayed screenshot will fill the last slot
		const recordDisabled = atMax || (wouldReachMax && this.delayedScreenshotPending);

		this.captureBtn.enabled = !screenshotDisabled;
		this.captureBtn.label = screenshotDisabled
			? maxMsg
			: localize('addScreenshot', "Add screenshot");

		if (this.recordBtn) {
			if (this.currentRecordingState !== RecordingState.Recording) {
				this.recordBtn.enabled = !recordDisabled;
				this.recordBtn.label = recordDisabled
					? maxMsg
					: localize('recordVideo', "Record video");
			}
		}

		// Floating bar buttons
		if (this.captureStripCaptureBtn) {
			this.captureStripCaptureBtn.classList.toggle('disabled', screenshotDisabled);
			this.captureStripCaptureBtn.title = screenshotDisabled ? maxMsg : '';
		}
		if (this.captureStripDelayBtn) {
			// Delay dropdown also disabled while countdown is running
			this.captureStripDelayBtn.classList.toggle('disabled', screenshotDisabled);
			this.captureStripDelayBtn.title = screenshotDisabled ? maxMsg : '';
		}
		if (this.captureStripRecordBtn) {
			if (this.currentRecordingState !== RecordingState.Recording) {
				this.captureStripRecordBtn.enabled = !recordDisabled;
				this.captureStripRecordBtn.element.title = recordDisabled ? maxMsg : localize('recordVideo', "Record video");
			}
		}

		// Disable "Preview on GitHub" while recording
		this.updateNextButtonForRecording();
	}

	private updateNextButtonForRecording(): void {
		if (this.currentStep !== WizardStep.Review) {
			return;
		}
		const recording = this.currentRecordingState === RecordingState.Recording;
		this.nextButton.enabled = !recording;
		this.nextButton.element.title = recording
			? localize('recordingActive', "Recording active")
			: localize('submitCtrlEnter', "Preview on GitHub ({0}+Enter)", isMacintosh ? '\u2318' : 'Ctrl');
	}

	private updateScreenshotThumbnails(): void {
		this.screenshotContainer.textContent = '';

		for (let i = 0; i < this.screenshots.length; i++) {
			const screenshot = this.screenshots[i];
			const card = append(this.screenshotContainer, $('div.wizard-screenshot-card'));

			const img = append(card, $('img')) as HTMLImageElement;
			img.src = screenshot.annotatedDataUrl ?? screenshot.dataUrl;
			img.alt = localize('screenshotAlt', "Screenshot {0}", i + 1);

			this.disposables.add(addDisposableListener(card, EventType.CLICK, () => {
				this._onDidRequestOpenScreenshot.fire(screenshot);
			}));

			const deleteBtn = append(card, $('div.wizard-screenshot-delete'));
			deleteBtn.setAttribute('role', 'button');
			deleteBtn.setAttribute('aria-label', localize('deleteScreenshot', "Delete screenshot"));
			deleteBtn.appendChild(renderIcon(Codicon.close));
			this.disposables.add(addDisposableListener(deleteBtn, EventType.CLICK, e => {
				e.stopPropagation();
				this.screenshots.splice(i, 1);
				this.updateScreenshotThumbnails();
				this.updateAttachmentButtons();
				this.updateStepUI();
			}));
		}

		// Recording thumbnails
		for (let i = 0; i < this.recordings.length; i++) {
			const rec = this.recordings[i];
			const card = append(this.screenshotContainer, $('div.wizard-screenshot-card.wizard-recording-card'));

			// Show video thumbnail if available
			if (rec.thumbnailDataUrl) {
				const thumbImg = append(card, $('img.wizard-screenshot-img')) as HTMLImageElement;
				thumbImg.setAttribute('src', rec.thumbnailDataUrl);
				thumbImg.alt = localize('recordingThumbnailAlt', "Recording {0}", i + 1);
				thumbImg.setAttribute('draggable', 'false');
			}

			// Dark overlay with play icon
			const playOverlay = append(card, $('div.wizard-recording-play'));
			playOverlay.appendChild(renderIcon(Codicon.play));

			const durSec = Math.floor(rec.durationMs / 1000);
			const durLabel = append(card, $('div.wizard-recording-duration'));
			durLabel.textContent = `${Math.floor(durSec / 60)}:${(durSec % 60).toString().padStart(2, '0')}`;

			// Click to open from OS
			this.disposables.add(addDisposableListener(card, EventType.CLICK, () => {
				this._onDidRequestOpenRecording.fire(rec.filePath);
			}));

			const deleteBtn = append(card, $('div.wizard-screenshot-delete'));
			deleteBtn.setAttribute('role', 'button');
			deleteBtn.setAttribute('aria-label', localize('deleteRecording', "Remove recording"));
			deleteBtn.appendChild(renderIcon(Codicon.close));
			this.disposables.add(addDisposableListener(deleteBtn, EventType.CLICK, e => {
				e.stopPropagation();
				this.recordings.splice(i, 1);
				this.updateScreenshotThumbnails();
				this.updateAttachmentButtons();
				this.updateStepUI();
			}));
		}

		if (this.getTotalAttachments() < MAX_ATTACHMENTS) {
			const wouldReachMax = this.getTotalAttachments() >= MAX_ATTACHMENTS - 1;
			const addDisabled = wouldReachMax && (this.currentRecordingState === RecordingState.Recording || this.delayedScreenshotPending);
			const addCard = append(this.screenshotContainer, $('div.wizard-screenshot-card.wizard-screenshot-add'));
			if (addDisabled) {
				addCard.classList.add('disabled');
				addCard.title = localize('maxAttachmentsReached', "Max attachments reached");
			}
			const plus = append(addCard, $('div.wizard-screenshot-plus'));
			plus.appendChild(renderIcon(Codicon.add));
			this.disposables.add(addDisposableListener(addCard, EventType.CLICK, () => {
				if (!addCard.classList.contains('disabled')) {
					this._onDidRequestScreenshot.fire();
				}
			}));
		}
	}

	private openAnnotationEditor(index: number): void {
		if (index < 0 || index >= this.screenshots.length) {
			return;
		}

		const screenshot = this.screenshots[index];
		const targetWindow = getWindow(this.wizardPanel);
		const editor = new ScreenshotAnnotationEditor(screenshot, targetWindow.document.body);

		editor.onDidSave(annotatedDataUrl => {
			screenshot.annotatedDataUrl = annotatedDataUrl;
			this.updateScreenshotThumbnails();
		});

		editor.onDidCancel(() => {
			// nothing to do, editor disposes itself
		});
	}

	getScreenshots(): readonly IScreenshot[] {
		return this.screenshots;
	}

	getRecordings(): readonly { filePath: string; durationMs: number; thumbnailDataUrl?: string }[] {
		return this.recordings;
	}

	private buildIssueBody(): string {
		const description = this.descriptionTextarea.value.trim();
		this.model.update({ issueDescription: description });

		let body = this.model.serialize();

		if (this.includeSettings && this.settingsContent) {
			body += `\n<details><summary>User Settings</summary>\n\n\`\`\`json\n${this.settingsContent}\n\`\`\`\n\n</details>`;
			if (this.workspaceSettingsContent) {
				body += `\n<details><summary>Workspace Settings</summary>\n\n\`\`\`json\n${this.workspaceSettingsContent}\n\`\`\`\n\n</details>`;
			}
		}

		if (this.screenshots.length > 0) {
			body += '\n\n### Screenshots\n\n';
			for (let i = 0; i < this.screenshots.length; i++) {
				body += `<!-- Screenshot ${i + 1} will be uploaded -->\n`;
			}
		}

		return body;
	}

	isVisible(): boolean {
		return this.visible;
	}

	focus(): void {
		this.wizardPanel.focus();
	}

	getPanel(): HTMLElement {
		return this.wizardPanel;
	}

	get recordingState(): RecordingState {
		return this.currentRecordingState;
	}

	hideFloatingBar(): void {
		if (this.floatingBar) {
			this.floatingBar.style.display = 'none';
		}
	}

	showFloatingBar(): void {
		if (this.floatingBar) {
			this.floatingBar.style.display = '';
		}
	}

	/** Update the internal model with additional data loaded asynchronously */
	updateModel(newData: Record<string, unknown>): void {
		this.model.update(newData);
		// Refresh review details if we're on the review step (async data may have arrived)
		if (this.currentStep === WizardStep.Review) {
			this.updateReviewDetails();
		}
	}

	setSettingsContent(userSettings: string, workspaceSettings?: string): void {
		this.settingsContent = userSettings;
		this.workspaceSettingsContent = workspaceSettings;
		if (this.currentStep === WizardStep.Review) {
			this.updateReviewDetails();
		}
	}

	hasUnsavedChanges(): boolean {
		if (this.submitted) {
			return false;
		}
		return this.hasUserInput();
	}

	private hasUserInput(): boolean {
		return !!(
			this.hasDescriptionContent() ||
			this.titleInput.value.trim() ||
			this.selectedIssueType !== undefined ||
			this.screenshots.length > 0 ||
			this.recordings.length > 0
		);
	}

	/** Mark as submitted — locks navigation and disables discard dialog */
	markAsSubmitted(): void {
		this.submitted = true;
	}

	/** Set the title input value (e.g., from AI generation) */
	setGeneratedTitle(title: string): void {
		this.titleInput.value = title;
	}

	/** Show a "Close" button next to the submit button after successful submission */
	showCloseButton(): void {
		this.backButton.element.style.display = 'none';

		// Add close button next to the existing preview button
		const nav = this.nextButton.element.parentElement;
		if (nav && !nav.querySelector('.wizard-close-btn')) {
			const closeBtn = this.disposables.add(new Button(nav, { ...defaultButtonStyles, secondary: true }));
			closeBtn.label = localize('closeTab', "Close");
			closeBtn.element.classList.add('wizard-close-btn');
			this.disposables.add(closeBtn.onDidClick(() => {
				this._onDidClose.fire();
			}));
		}
	}

	getWizardHeight(): number {
		return this.wizardPanel.offsetHeight;
	}

	setRecordingState(state: RecordingState): void {
		this.currentRecordingState = state;

		if (state === RecordingState.Recording) {
			this.recordingStartTime = Date.now();

			const formatTime = () => {
				const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
				const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
				const secs = (elapsed % 60).toString().padStart(2, '0');
				return `${mins}:${secs}`;
			};

			const stopLabel = localize('stopRecording', "Stop recording");
			const makeLabel = () => `$(stop-circle) ${stopLabel} ${formatTime()}`;

			if (this.recordBtn) {
				this.recordBtn.element.classList.add('recording');
				this.recordBtn.label = makeLabel();
				this.recordingElapsedLabel.style.display = 'none';
			}

			if (this.captureStripRecordBtn) {
				this.captureStripRecordBtn.element.classList.add('recording');
				this.captureStripRecordBtn.element.title = stopLabel;
				this.captureStripRecordBtn.label = makeLabel();
			}

			this.recordingElapsedTimer = setInterval(() => {
				const label = makeLabel();
				if (this.recordBtn) {
					this.recordBtn.label = label;
				}
				if (this.captureStripRecordBtn) {
					this.captureStripRecordBtn.label = label;
				}
			}, 1000);
		} else {
			// Back to idle
			if (this.recordBtn) {
				this.recordBtn.element.classList.remove('recording');
				this.recordBtn.label = localize('recordVideo', "Record video");
				this.recordingElapsedLabel.style.display = 'none';
			}
			if (this.recordingElapsedTimer !== undefined) {
				clearInterval(this.recordingElapsedTimer);
				this.recordingElapsedTimer = undefined;
			}

			if (this.captureStripRecordBtn) {
				this.captureStripRecordBtn.element.classList.remove('recording');
				this.captureStripRecordBtn.element.title = localize('recordVideo', "Record video");
				this.captureStripRecordBtn.label = `$(record) ${localize('recordVideo', "Record video")}`;
			}
		}

		this.updateScreenshotThumbnails();
		this.updateAttachmentButtons();
	}

	addRecording(filePath: string, durationMs: number, thumbnailDataUrl?: string): void {
		this.recordings.push({ filePath, durationMs, thumbnailDataUrl });
		this.updateScreenshotThumbnails();
		this.updateAttachmentButtons();
		this.updateStepUI();
	}

	dispose(): void {
		if (this.recordingElapsedTimer !== undefined) {
			clearInterval(this.recordingElapsedTimer);
		}
		this.disposables.dispose();
		this._onDidClose.dispose();
		this._onDidSubmit.dispose();
		this._onDidRequestScreenshot.dispose();
		this._onDidRequestStartRecording.dispose();
		this._onDidRequestStopRecording.dispose();
		this._onDidRequestOpenRecording.dispose();
		this._onDidRequestOpenScreenshot.dispose();
		this._onDidRequestGenerateTitle.dispose();
	}
}
