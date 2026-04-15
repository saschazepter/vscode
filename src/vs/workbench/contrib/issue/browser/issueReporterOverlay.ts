/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/issueReporterOverlay.css';
import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IssueReporterData, IssueType } from '../common/issue.js';
import { IssueReporterModel } from './issueReporterModel.js';
import { RecordingState } from './recordingService.js';
import { ScreenshotAnnotationEditor } from './screenshotAnnotation.js';

const MAX_ATTACHMENTS = 5;

const enum WizardStep {
	Describe = 0,
	Categorize = 1,
	Screenshots = 2,
	Review = 3,
}

const STEP_COUNT = 4;

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

	// Step 1: Describe
	private descriptionTextarea!: HTMLTextAreaElement;

	// Step 2: Categorize
	private readonly issueTypeButtons: HTMLElement[] = [];
	private selectedIssueType: IssueType | undefined;
	private typeButtonGroup!: HTMLElement;

	// Step 3: Screenshots & Recording
	private screenshotContainer!: HTMLElement;
	private screenshotDelay = 0;
	private captureBtn!: HTMLElement;
	private captureLabel!: HTMLElement;
	private recordBtn: HTMLElement | undefined;
	private recordLabel!: HTMLElement;
	private recordingElapsedLabel!: HTMLElement;
	private recordingElapsedTimer: ReturnType<typeof setInterval> | undefined;
	private recordingStartTime = 0;
	private currentRecordingState = RecordingState.Idle;
	private readonly recordings: { filePath: string; durationMs: number; thumbnailDataUrl?: string }[] = [];

	// Step 4: Review
	private titleInput!: HTMLInputElement;
	private reviewThumbCards: HTMLElement[] = [];
	private uploading = false;

	// Navigation
	private stepIndicator!: HTMLElement;
	private stepLabel!: HTMLElement;
	private backButton!: HTMLElement;
	private nextButton!: HTMLElement;
	private nextShortcutBadge!: HTMLElement;

	// Progress dots
	private readonly progressDots: HTMLElement[] = [];

	private currentStep: WizardStep = WizardStep.Describe;
	private readonly screenshots: IScreenshot[] = [];
	private readonly model: IssueReporterModel;
	private visible = false;
	private floatingBar: HTMLElement | undefined;
	private submitted = false;

	constructor(
		private readonly data: IssueReporterData,
		private readonly layoutService: IWorkbenchLayoutService,
		private readonly recordingSupported: boolean = false,
		private readonly container: HTMLElement,
	) {
		this.model = new IssueReporterModel({
			...data,
			issueType: data.issueType || IssueType.Bug,
			allExtensions: data.enabledExtensions,
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
		this.createStep1Describe();
		this.createStep2Categorize();
		this.createStep3Screenshots();
		this.createStep4Review();

		// ── Bottom navigation ──
		const nav = append(this.wizardPanel, $('div.wizard-nav'));

		this.backButton = append(nav, $('div.wizard-nav-btn.wizard-back'));
		const backArrow = append(this.backButton, $('span'));
		backArrow.textContent = '\u2190'; // ←
		const backLabel = append(this.backButton, $('span'));
		backLabel.textContent = localize('back', "Back");
		const backShortcut = append(this.backButton, $('span.wizard-shortcut-badge'));
		backShortcut.textContent = 'Esc';
		this.backButton.setAttribute('role', 'button');
		this.backButton.setAttribute('tabindex', '0');
		this.backButton.title = localize('backEscape', "Back (Escape)");

		this.nextButton = append(nav, $('div.wizard-nav-btn.wizard-next.primary'));
		const nextLabel = append(this.nextButton, $('span.wizard-next-label'));
		nextLabel.textContent = localize('next', "Next");
		const nextArrow = append(this.nextButton, $('span.wizard-next-arrow'));
		nextArrow.textContent = ' \u2192'; // →
		this.nextShortcutBadge = append(this.nextButton, $('span.wizard-shortcut-badge'));
		this.nextShortcutBadge.textContent = isMacintosh ? '\u2318\u23CE' : 'Ctrl+\u23CE';
		this.nextButton.setAttribute('role', 'button');
		this.nextButton.setAttribute('tabindex', '0');
		const ctrlKey = isMacintosh ? '\u2318' : 'Ctrl';
		this.nextButton.title = localize('nextCtrlEnter', "Next ({0}+Enter)", ctrlKey);

		this.registerEventHandlers();
		this.updateStepUI();
	}

	// ── Step 1: Describe ──
	private createStep1Describe(): void {
		const page = append(this.stepContainer, $('div.wizard-step'));
		this.stepPages.push(page);

		const heading = append(page, $('h2.wizard-heading'));
		heading.textContent = localize('sendFeedback', "Send us your feedback");

		const subtitle = append(page, $('p.wizard-subtitle'));
		subtitle.textContent = localize('describeSubtitle', "Add a short description of what you encountered");

		this.descriptionTextarea = append(page, $('textarea.wizard-textarea')) as HTMLTextAreaElement;
		this.descriptionTextarea.placeholder = localize('descriptionPlaceholder', "Describe the issue. What did you expect, and what happened instead?");
		this.descriptionTextarea.rows = 5;
		if (this.data.issueBody) {
			this.descriptionTextarea.value = this.data.issueBody;
		}

		this.disposables.add(addDisposableListener(this.descriptionTextarea, EventType.INPUT, () => {
			this.descriptionTextarea.classList.remove('invalid-input');
		}));
	}

	// ── Step 2: Categorize ──
	private createStep2Categorize(): void {
		const page = append(this.stepContainer, $('div.wizard-step'));
		this.stepPages.push(page);

		const heading = append(page, $('h2.wizard-heading'));
		heading.textContent = localize('categorize', "What kind of feedback is this?");

		const subtitle = append(page, $('p.wizard-subtitle'));
		subtitle.textContent = localize('categorizeSubtitle', "Selecting the right category helps us identify and route your feedback to the correct team");

		this.typeButtonGroup = append(page, $('div.wizard-type-buttons'));
		const types = [
			{ type: IssueType.Bug, label: localize('bug', "Bug"), icon: Codicon.bug, shortcut: '1' },
			{ type: IssueType.FeatureRequest, label: localize('featureRequest', "Feature Request"), icon: Codicon.lightbulb, shortcut: '2' },
			{ type: IssueType.PerformanceIssue, label: localize('performanceIssue', "Performance Issue"), icon: Codicon.dashboard, shortcut: '3' },
		];

		const selectType = (type: IssueType) => {
			this.selectedIssueType = type;
			this.model.update({ issueType: type });
			this.typeButtonGroup.classList.remove('invalid-input');
			for (const b of this.issueTypeButtons) {
				b.classList.toggle('selected', b.getAttribute('data-type') === String(type));
			}
		};

		for (const { type, label, icon, shortcut } of types) {
			const btn = append(this.typeButtonGroup, $('div.wizard-type-btn'));
			btn.setAttribute('role', 'button');
			btn.setAttribute('tabindex', '0');
			btn.setAttribute('data-type', String(type));

			const shortcutBadge = append(btn, $('span.wizard-shortcut-badge'));
			shortcutBadge.textContent = shortcut;
			const iconEl = append(btn, $('span.wizard-type-icon'));
			iconEl.appendChild(renderIcon(icon));
			const labelEl = append(btn, $('span'));
			labelEl.textContent = label;

			this.issueTypeButtons.push(btn);

			this.disposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				selectType(type);
			}));

			this.disposables.add(addDisposableListener(btn, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					btn.click();
				}
			}));
		}

		// Number key shortcuts for category selection (1, 2, 3)
		this.disposables.add(addDisposableListener(this.wizardPanel, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (this.currentStep !== WizardStep.Categorize) {
				return;
			}
			const index = ['1', '2', '3'].indexOf(e.key);
			if (index >= 0 && index < types.length) {
				e.preventDefault();
				selectType(types[index].type);
			}
		}));
	}

	// ── Step 3: Screenshots ──
	private createStep3Screenshots(): void {
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

		this.captureBtn = append(actions, $('div.wizard-nav-btn.wizard-capture-btn.primary'));
		this.captureBtn.setAttribute('role', 'button');
		this.captureBtn.setAttribute('tabindex', '0');
		const cameraIcon = append(this.captureBtn, $('span.wizard-capture-icon'));
		cameraIcon.appendChild(renderIcon(Codicon.deviceCamera));
		this.captureLabel = append(this.captureBtn, $('span.wizard-capture-label'));
		this.captureLabel.textContent = localize('addScreenshot', "Add screenshot");

		this.disposables.add(addDisposableListener(this.captureBtn, EventType.CLICK, () => {
			if (this.getTotalAttachments() >= MAX_ATTACHMENTS || this.captureBtn.classList.contains('disabled')) {
				return;
			}
			if (this.screenshotDelay > 0) {
				this.captureBtn.classList.add('disabled');
				const origText = this.captureLabel.textContent;
				let remaining = this.screenshotDelay;
				this.captureLabel.textContent = `${remaining}...`;
				const interval = setInterval(() => {
					remaining--;
					if (remaining > 0) {
						this.captureLabel.textContent = `${remaining}...`;
					} else {
						clearInterval(interval);
						this.captureLabel.textContent = origText;
						this.captureBtn.classList.remove('disabled');
						this._onDidRequestScreenshot.fire();
					}
				}, 1000);
			} else {
				this._onDidRequestScreenshot.fire();
			}
		}));

		// Record video button (only when supported)
		if (this.recordingSupported) {
			this.recordBtn = append(actions, $('div.wizard-nav-btn.wizard-record-btn'));
			this.recordBtn.setAttribute('role', 'button');
			this.recordBtn.setAttribute('tabindex', '0');
			const recordIcon = append(this.recordBtn, $('span.wizard-record-icon'));
			recordIcon.appendChild(renderIcon(Codicon.record));
			this.recordLabel = append(this.recordBtn, $('span.wizard-record-label'));
			this.recordLabel.textContent = localize('recordVideo', "Record video");

			this.recordingElapsedLabel = append(this.recordBtn, $('span.wizard-recording-elapsed'));
			this.recordingElapsedLabel.style.display = 'none';

			this.disposables.add(addDisposableListener(this.recordBtn, EventType.CLICK, () => {
				if (this.currentRecordingState === RecordingState.Recording) {
					this._onDidRequestStopRecording.fire();
				} else if (this.currentRecordingState === RecordingState.Idle && this.getTotalAttachments() < MAX_ATTACHMENTS) {
					this._onDidRequestStartRecording.fire();
				}
			}));
		}

		this.screenshotContainer = append(page, $('div.wizard-screenshots'));

		// Hide inline actions and use the floating capture bar instead
		actions.style.display = 'none';
		this.createFloatingCaptureBar();
	}

	private captureStripRecordBtn: HTMLElement | undefined;
	private captureStripRecordLbl: HTMLElement | undefined;
	private captureStripRecordElapsed: HTMLElement | undefined;

	private createFloatingCaptureBar(): void {
		const workbenchContainer = this.layoutService.mainContainer;
		const targetWindow = getWindow(workbenchContainer);
		const body = targetWindow.document.body;

		this.floatingBar = $('div.wizard-capture-strip');

		// Delay dropdown
		const delayGroup = append(this.floatingBar, $('div.wizard-capture-strip-group'));
		const delayLabel = append(delayGroup, $('label.wizard-capture-strip-delay-label'));
		delayLabel.textContent = localize('delay', "Delay:");
		const delaySelect = append(delayGroup, $('select.wizard-capture-strip-delay')) as HTMLSelectElement;
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

		// Screenshot button
		const captureBtn = append(this.floatingBar, $('div.wizard-nav-btn.wizard-capture-btn.primary'));
		captureBtn.setAttribute('role', 'button');
		captureBtn.setAttribute('tabindex', '0');
		const cameraIcon = append(captureBtn, $('span'));
		cameraIcon.appendChild(renderIcon(Codicon.deviceCamera));
		const captureLbl = append(captureBtn, $('span'));
		captureLbl.textContent = localize('addScreenshot', "Add screenshot");
		this.disposables.add(addDisposableListener(captureBtn, EventType.CLICK, () => {
			if (this.getTotalAttachments() < MAX_ATTACHMENTS && !captureBtn.classList.contains('disabled')) {
				if (this.screenshotDelay > 0) {
					captureBtn.classList.add('disabled');
					let remaining = this.screenshotDelay;
					captureLbl.textContent = `${remaining}...`;
					const interval = setInterval(() => {
						remaining--;
						if (remaining > 0) {
							captureLbl.textContent = `${remaining}...`;
						} else {
							clearInterval(interval);
							captureLbl.textContent = localize('addScreenshot', "Add screenshot");
							captureBtn.classList.remove('disabled');
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
			this.captureStripRecordBtn = append(this.floatingBar, $('div.wizard-nav-btn.wizard-record-btn'));
			this.captureStripRecordBtn.setAttribute('role', 'button');
			this.captureStripRecordBtn.setAttribute('tabindex', '0');
			const recordIcon = append(this.captureStripRecordBtn, $('span.wizard-record-icon'));
			recordIcon.appendChild(renderIcon(Codicon.record));
			this.captureStripRecordLbl = append(this.captureStripRecordBtn, $('span'));
			this.captureStripRecordLbl.textContent = localize('recordVideo', "Record video");
			this.captureStripRecordElapsed = append(this.captureStripRecordBtn, $('span.wizard-recording-elapsed'));
			this.captureStripRecordElapsed.style.display = 'none';
			this.disposables.add(addDisposableListener(this.captureStripRecordBtn, EventType.CLICK, () => {
				if (this.currentRecordingState === RecordingState.Recording) {
					this._onDidRequestStopRecording.fire();
				} else if (this.currentRecordingState === RecordingState.Idle && this.getTotalAttachments() < MAX_ATTACHMENTS) {
					this._onDidRequestStartRecording.fire();
				}
			}));
		}

		// Insert as body sibling before the workbench (like titlebar mode)
		// and use the same layout mechanism to push the workbench down
		body.insertBefore(this.floatingBar, workbenchContainer);

		// Only visible on step 3
		this.updateCaptureStripVisibility();

		this.disposables.add(toDisposable(() => {
			this.floatingBar?.remove();
			body.classList.remove('issue-reporter-active');
			this.layoutService.layout();
		}));
	}

	private updateCaptureStripVisibility(): void {
		if (!this.floatingBar) {
			return;
		}
		const workbenchContainer = this.layoutService.mainContainer;
		const targetWindow = getWindow(workbenchContainer);
		const body = targetWindow.document.body;
		const shouldShow = this.currentStep === WizardStep.Screenshots;

		this.floatingBar.style.display = shouldShow ? '' : 'none';
		body.classList.toggle('issue-reporter-active', shouldShow);
		this.layoutService.layout();
	}

	// ── Step 4: Review & Submit ──
	private createStep4Review(): void {
		const page = append(this.stepContainer, $('div.wizard-step.wizard-step-review'));
		this.stepPages.push(page);

		const heading = append(page, $('h2.wizard-heading'));
		heading.textContent = localize('reviewSubmit', "Review and submit");

		// Title input
		const titleGroup = append(page, $('div.wizard-field'));
		const titleLabel = append(titleGroup, $('label.wizard-field-label'));
		titleLabel.textContent = localize('issueTitle', "Issue title");
		this.titleInput = append(titleGroup, $('input.wizard-title-input')) as HTMLInputElement;
		this.titleInput.type = 'text';
		this.titleInput.placeholder = localize('issueTitlePlaceholder', "Brief summary of the issue");
		if (this.data.issueTitle) {
			this.titleInput.value = this.data.issueTitle;
		}

		this.disposables.add(addDisposableListener(this.titleInput, EventType.INPUT, () => {
			this.titleInput.classList.remove('invalid-input');
		}));

		// Review details (filled dynamically) — compact horizontal layout
		append(page, $('div.wizard-review-details'));
	}

	private registerEventHandlers(): void {
		// Back
		this.disposables.add(addDisposableListener(this.backButton, EventType.CLICK, () => this.goBack()));
		this.disposables.add(addDisposableListener(this.backButton, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === ' ') {
				e.preventDefault();
				this.goBack();
			}
		}));

		// Next
		this.disposables.add(addDisposableListener(this.nextButton, EventType.CLICK, () => this.goNext()));
		this.disposables.add(addDisposableListener(this.nextButton, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === ' ') {
				e.preventDefault();
				this.goNext();
			}
		}));

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
				if (this.currentStep > WizardStep.Describe) {
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
		if (this.currentStep > WizardStep.Describe) {
			this.setStep(this.currentStep - 1);
		}
	}

	private goNext(): void {
		if (this.submitted && this.currentStep !== WizardStep.Review) {
			return;
		}
		if (this.currentStep === WizardStep.Describe) {
			const desc = this.descriptionTextarea.value.trim();
			if (!desc) {
				this.descriptionTextarea.classList.add('invalid-input');
				this.descriptionTextarea.focus();
				return;
			}
			this.descriptionTextarea.classList.remove('invalid-input');
			this.model.update({ issueDescription: desc });
		}

		if (this.currentStep === WizardStep.Categorize && this.selectedIssueType === undefined) {
			this.typeButtonGroup.classList.add('invalid-input');
			return;
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

		const direction = step > oldStep ? 1 : -1;
		const oldPage = this.stepPages[oldStep];
		const newPage = this.stepPages[step];

		oldPage.classList.add(direction > 0 ? 'slide-out-left' : 'slide-out-right');
		newPage.classList.remove('slide-out-left', 'slide-out-right', 'slide-in-left', 'slide-in-right');
		newPage.classList.add(direction > 0 ? 'slide-in-right' : 'slide-in-left');
		newPage.style.display = 'flex';

		setTimeout(() => {
			oldPage.style.display = 'none';
			oldPage.classList.remove('slide-out-left', 'slide-out-right');
			newPage.classList.remove('slide-in-left', 'slide-in-right');
		}, 250);

		this.updateStepUI();

		if (step === WizardStep.Describe) {
			this.descriptionTextarea.focus();
		} else if (step === WizardStep.Review) {
			this.updateReviewDetails();
			this.titleInput.focus();
		} else {
			// Categorize / Screenshots — focus the panel so keyboard shortcuts work
			this.wizardPanel.focus();
		}
	}

	private updateStepUI(): void {
		const stepNum = this.currentStep + 1;
		this.stepIndicator.textContent = localize('stepOf', "Step {0} of {1}", stepNum, STEP_COUNT);

		const stepNames = [
			localize('composeMessage', "Compose message"),
			localize('labels', "Category"),
			localize('screenshots', "Screenshots"),
			localize('submit', "Submit"),
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
		this.backButton.style.display = this.currentStep === WizardStep.Describe ? 'none' : '';

		// Next button label
		const ctrlKey = isMacintosh ? '\u2318' : 'Ctrl';
		const nextLabel = this.nextButton.querySelector('.wizard-next-label');
		const nextArrow = this.nextButton.querySelector('.wizard-next-arrow');
		if (this.currentStep === WizardStep.Review) {
			if (nextLabel) {
				nextLabel.textContent = localize('previewOnGitHub', "Preview on GitHub");
			}
			if (nextArrow) {
				nextArrow.textContent = ' \u2192'; // →
			}
			this.nextButton.classList.remove('submit');
			this.nextButton.classList.add('primary');
			this.nextButton.title = localize('submitCtrlEnter', "Preview on GitHub ({0}+Enter)", ctrlKey);
		} else if (this.currentStep === WizardStep.Screenshots) {
			if (nextLabel) {
				nextLabel.textContent = this.screenshots.length === 0
					? localize('skip', "Skip")
					: localize('next', "Next");
			}
			if (nextArrow) {
				nextArrow.textContent = ' \u00BB'; // »
			}
			this.nextButton.classList.remove('submit');
			this.nextButton.title = localize('nextCtrlEnter', "Next ({0}+Enter)", ctrlKey);
		} else {
			if (nextLabel) {
				nextLabel.textContent = localize('next', "Next");
			}
			if (nextArrow) {
				nextArrow.textContent = ' \u2192'; // →
			}
			this.nextButton.classList.remove('submit');
			this.nextButton.title = localize('nextCtrlEnter', "Next ({0}+Enter)", ctrlKey);
		}

		// Show/hide capture strip (only on step 3)
		this.updateCaptureStripVisibility();
	}

	private updateReviewDetails(): void {
		const page = this.stepPages[WizardStep.Review];
		const details = page.querySelector('.wizard-review-details');
		if (!details) {
			return;
		}
		details.textContent = '';

		// Compact: Description · Category on one row
		const infoRow = append(details as HTMLElement, $('div.review-info-row'));

		const descSection = append(infoRow, $('div.review-section'));
		const descLabel = append(descSection, $('div.review-label'));
		descLabel.textContent = localize('description', "Description");
		const descValue = append(descSection, $('div.review-value'));
		descValue.textContent = this.descriptionTextarea.value.trim() || localize('noDescription', "(no description)");

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
					const thumbImg = append(card, $('img'));
					thumbImg.setAttribute('src', rec.thumbnailDataUrl);
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
	}

	/** Called by the form service to show upload progress */
	setUploading(uploading: boolean): void {
		this.uploading = uploading;
		const nextLabel = this.nextButton.querySelector('.wizard-next-label');
		const nextArrow = this.nextButton.querySelector('.wizard-next-arrow');

		if (uploading) {
			this.nextButton.classList.add('uploading');
			if (nextLabel) {
				nextLabel.textContent = localize('uploading', "Uploading...");
			}
			if (nextArrow) {
				nextArrow.textContent = '';
				const spinner = document.createElement('span');
				spinner.className = 'wizard-btn-spinner';
				nextArrow.appendChild(spinner);
			}
			this.backButton.style.display = 'none';
		} else {
			this.nextButton.classList.remove('uploading');
			if (nextLabel) {
				nextLabel.textContent = localize('previewOnGitHub', "Preview on GitHub");
			}
			if (nextArrow) {
				nextArrow.textContent = ' \u2192';
			}
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
			this.titleInput.classList.add('invalid-input');
			this.titleInput.focus();
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
		this.descriptionTextarea.focus();
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

		this.captureBtn.classList.toggle('disabled', atMax);
		this.captureLabel.textContent = atMax
			? localize('maxAttachmentsReached', "Max attachments reached")
			: localize('addScreenshot', "Add screenshot");

		if (this.recordBtn) {
			this.recordBtn.classList.toggle('disabled', atMax);
			if (this.currentRecordingState !== RecordingState.Recording) {
				this.recordLabel.textContent = atMax
					? localize('maxAttachmentsReached', "Max attachments reached")
					: localize('recordVideo', "Record video");
			}
		}
	}

	private updateScreenshotThumbnails(): void {
		this.screenshotContainer.textContent = '';

		if (this.screenshots.length === 0 && this.recordings.length === 0) {
			const empty = append(this.screenshotContainer, $('div.wizard-screenshots-empty'));
			empty.textContent = localize('noScreenshots', "No screenshots or recordings added yet");
			return;
		}

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
				const thumbImg = append(card, $('img.wizard-screenshot-img'));
				thumbImg.setAttribute('src', rec.thumbnailDataUrl);
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
			const addCard = append(this.screenshotContainer, $('div.wizard-screenshot-card.wizard-screenshot-add'));
			const plus = append(addCard, $('div.wizard-screenshot-plus'));
			plus.appendChild(renderIcon(Codicon.add));
			this.disposables.add(addDisposableListener(addCard, EventType.CLICK, () => {
				this._onDidRequestScreenshot.fire();
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
		const description = this.descriptionTextarea.value;
		this.model.update({ issueDescription: description });

		let body = this.model.serialize();

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

	getCaptureStripHeight(): number {
		return this.floatingBar?.offsetHeight ?? 0;
	}

	hasUnsavedChanges(): boolean {
		if (this.submitted) {
			return false;
		}
		return this.hasUserInput();
	}

	private hasUserInput(): boolean {
		return !!(
			this.descriptionTextarea.value.trim() ||
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

	/** Show a "Close" button next to the submit button after successful submission */
	showCloseButton(): void {
		this.backButton.style.display = 'none';

		// Add close button next to the existing preview button
		const nav = this.nextButton.parentElement;
		if (nav && !nav.querySelector('.wizard-close-btn')) {
			const closeBtn = append(nav, $('div.wizard-nav-btn.wizard-close-btn'));
			closeBtn.setAttribute('role', 'button');
			closeBtn.setAttribute('tabindex', '0');
			const closeLbl = append(closeBtn, $('span'));
			closeLbl.textContent = localize('closeTab', "Close");
			this.disposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => {
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
			// Switch to recording mode: disable all wizard UI except stop button
			this.wizardPanel.classList.add('wizard-recording');
			if (this.recordBtn) {
				this.recordBtn.classList.add('recording');
				this.recordLabel.textContent = localize('stopRecording', "Stop recording");
				this.recordingElapsedLabel.style.display = '';
				this.recordingStartTime = Date.now();
				this.recordingElapsedLabel.textContent = '0:00';
				this.recordingElapsedTimer = setInterval(() => {
					const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
					const mins = Math.floor(elapsed / 60);
					const secs = elapsed % 60;
					const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
					this.recordingElapsedLabel.textContent = timeStr;
					if (this.captureStripRecordElapsed) {
						this.captureStripRecordElapsed.textContent = timeStr;
					}
				}, 1000);
			}

			// Update capture strip record button
			if (this.captureStripRecordBtn && this.captureStripRecordLbl) {
				this.captureStripRecordBtn.classList.add('recording');
				this.captureStripRecordLbl.textContent = localize('stopRecording', "Stop recording");
				if (this.captureStripRecordElapsed) {
					this.captureStripRecordElapsed.style.display = '';
					this.captureStripRecordElapsed.textContent = '0:00';
				}
			}
			// Dim other capture strip controls during recording
			if (this.floatingBar) {
				this.floatingBar.classList.add('wizard-strip-recording');
			}
		} else {
			// Back to idle
			this.wizardPanel.classList.remove('wizard-recording');
			if (this.recordBtn) {
				this.recordBtn.classList.remove('recording');
				this.recordLabel.textContent = localize('recordVideo', "Record video");
				this.recordingElapsedLabel.style.display = 'none';
			}
			if (this.recordingElapsedTimer !== undefined) {
				clearInterval(this.recordingElapsedTimer);
				this.recordingElapsedTimer = undefined;
			}

			// Update capture strip record button
			if (this.captureStripRecordBtn && this.captureStripRecordLbl) {
				this.captureStripRecordBtn.classList.remove('recording');
				this.captureStripRecordLbl.textContent = localize('recordVideo', "Record video");
				if (this.captureStripRecordElapsed) {
					this.captureStripRecordElapsed.style.display = 'none';
				}
			}
			if (this.floatingBar) {
				this.floatingBar.classList.remove('wizard-strip-recording');
			}
		}
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
	}
}
