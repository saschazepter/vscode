/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IManagedHoverContent } from '../../../../../base/browser/ui/hover/hover.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { IMenuEntryActionViewItemOptions, MenuEntryActionViewItem } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IChatSpeechToTextService } from './chatSpeechToTextService.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Radius of the progress ring in the 16×16 viewBox used for the toolbar icon. */
const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Toolbar affordance shown while the on-device dictation model is downloading:
 * a download icon wrapped by a circular progress ring that fills as bytes
 * arrive, plus a rich hover reporting the exact percentage. Replaces the plain
 * spinning mic so the wait reads as a determinate download rather than a hang.
 * When the download fraction is not yet known (or the model is loading into
 * memory) the ring falls back to an indeterminate spin.
 */
export class DictationDownloadActionViewItem extends MenuEntryActionViewItem {

	private _progressCircle: SVGCircleElement | undefined;
	private _ringElement: SVGSVGElement | undefined;

	constructor(
		action: MenuItemAction,
		options: IMenuEntryActionViewItemOptions | undefined,
		@IChatSpeechToTextService private readonly _speechToTextService: IChatSpeechToTextService,
		@IKeybindingService keybindingService: IKeybindingService,
		@INotificationService notificationService: INotificationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
	) {
		super(action, options, keybindingService, notificationService, contextKeyService, themeService, contextMenuService, accessibilityService);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('dictation-download-item');

		const ownerDocument = container.ownerDocument;
		const svg = ownerDocument.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
		svg.classList.add('dictation-download-ring');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('aria-hidden', 'true');

		const track = ownerDocument.createElementNS(SVG_NS, 'circle') as SVGCircleElement;
		track.classList.add('dictation-download-ring-track');
		track.setAttribute('cx', '8');
		track.setAttribute('cy', '8');
		track.setAttribute('r', String(RING_RADIUS));

		const progress = ownerDocument.createElementNS(SVG_NS, 'circle') as SVGCircleElement;
		progress.classList.add('dictation-download-ring-progress');
		progress.setAttribute('cx', '8');
		progress.setAttribute('cy', '8');
		progress.setAttribute('r', String(RING_RADIUS));
		progress.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));

		svg.appendChild(track);
		svg.appendChild(progress);
		container.appendChild(svg);

		this._ringElement = svg;
		this._progressCircle = progress;

		this._register(this._speechToTextService.onDidChangeModelDownloadProgress(() => this._updateProgress()));
		this._updateProgress();
	}

	private _updateProgress(): void {
		if (!this._ringElement || !this._progressCircle) {
			return;
		}
		const progress = this._speechToTextService.modelDownloadProgress;
		if (progress === undefined) {
			// Fraction unknown or model loading: spin a fixed arc so the ring
			// still reads as active rather than stuck empty.
			this._ringElement.classList.add('indeterminate');
			this._progressCircle.style.strokeDashoffset = String(RING_CIRCUMFERENCE * 0.75);
		} else {
			this._ringElement.classList.remove('indeterminate');
			this._progressCircle.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
		}
		// Refresh the rich hover so its reported percentage stays in sync.
		this.updateTooltip();
	}

	protected override getHoverContents(): IManagedHoverContent {
		const markdown = new MarkdownString('', { supportThemeIcons: true });
		markdown.appendMarkdown(localize('chatStt.hover.title', "**Downloading speech-to-text model**"));
		markdown.appendMarkdown('\n\n');
		const progress = this._speechToTextService.modelDownloadProgress;
		if (progress === undefined) {
			markdown.appendMarkdown(localize('chatStt.hover.preparing', "Preparing the on-device model. This happens only the first time you dictate."));
		} else {
			markdown.appendMarkdown(localize('chatStt.hover.percent', "{0}% downloaded. This happens only the first time you dictate.", Math.round(progress * 100)));
		}
		return { markdown, markdownNotSupportedFallback: markdown.value };
	}
}
