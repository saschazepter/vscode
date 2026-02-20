/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../widget/chatContentParts/media/chatInlineAnchorWidget.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { dirname } from '../../../../../base/common/resources.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { getIconClasses } from '../../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize } from '../../../../../nls.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IChatDebugEventFileListContent } from '../../common/chatDebugService.js';
import { InlineAnchorWidget } from '../widget/chatContentParts/chatInlineAnchorWidget.js';

const $ = DOM.$;

/**
 * Map a discovery type string to its corresponding settings key.
 */
function getSettingsKeyForDiscoveryType(discoveryType: string): string | undefined {
	switch (discoveryType) {
		case 'prompt': return 'chat.promptFilesLocations';
		case 'instructions': return 'chat.instructionsFilesLocations';
		case 'agent': return 'chat.agentFilesLocations';
		case 'skill': return 'chat.agentSkillsLocations';
		case 'hook': return 'chat.hookFilesLocations';
		default: return undefined;
	}
}

/**
 * Get a display label for a file's location.
 * Extension files show the extension ID,
 * all other files show the relative (or tildified) parent folder path.
 */
function getFileLocationLabel(file: { uri: URI; storage?: string; extensionId?: string }, labelService: ILabelService): string {
	if (file.extensionId) {
		return file.extensionId;
	}
	return labelService.getUriLabel(dirname(file.uri), { relative: true });
}

/**
 * Create a file link element styled like the chat panel's InlineAnchorWidget.
 */
function createInlineFileLink(uri: URI, displayText: string, fileKind: FileKind, openerService: IOpenerService, modelService: IModelService, languageService: ILanguageService, hoverService: IHoverService, labelService: ILabelService, disposables: DisposableStore, hoverSuffix?: string): HTMLElement {
	const link = $(`a.${InlineAnchorWidget.className}.show-file-icons`);

	const iconEl = DOM.append(link, $('span.icon'));
	const iconClasses = getIconClasses(modelService, languageService, uri, fileKind);
	iconEl.classList.add(...iconClasses);

	DOM.append(link, $('span.icon-label', undefined, displayText));

	const relativeLabel = labelService.getUriLabel(uri, { relative: true });
	const hoverText = hoverSuffix ? `${relativeLabel} ${hoverSuffix}` : relativeLabel;
	disposables.add(hoverService.setupManagedHover(getDefaultHoverDelegate('element'), link, hoverText));
	disposables.add(DOM.addDisposableListener(link, DOM.EventType.CLICK, (e) => {
		e.preventDefault();
		openerService.open(uri);
	}));

	return link;
}

/**
 * Append a location badge to a row. If the file comes from an extension,
 * the badge is a clickable link that opens the extension in the marketplace.
 */
function appendLocationBadge(row: HTMLElement, file: { extensionId?: string }, badgeText: string, cssClass: string, openerService: IOpenerService, hoverService: IHoverService, disposables: DisposableStore): void {
	if (file.extensionId) {
		const link = DOM.append(row, $(`a.${cssClass}.chat-debug-file-list-badge-link`));
		link.textContent = badgeText;
		disposables.add(hoverService.setupManagedHover(getDefaultHoverDelegate('element'), link, localize('chatDebug.openExtension', "Open {0} in Extensions", file.extensionId)));
		disposables.add(DOM.addDisposableListener(link, DOM.EventType.CLICK, (e) => {
			e.preventDefault();
			e.stopPropagation();
			openerService.open(URI.parse(`command:extension.open?${encodeURIComponent(JSON.stringify([file.extensionId]))}`), { allowCommands: true });
		}));
	} else {
		DOM.append(row, $(`span.${cssClass}`, undefined, badgeText));
	}
}

/**
 * Render a file list resolved content as a rich HTML element.
 */
export function renderFileListContent(content: IChatDebugEventFileListContent, openerService: IOpenerService, modelService: IModelService, languageService: ILanguageService, hoverService: IHoverService, labelService: ILabelService): { element: HTMLElement; disposables: DisposableStore } {
	const disposables = new DisposableStore();
	const container = $('div.chat-debug-file-list');
	container.tabIndex = 0;

	const capitalizedType = content.discoveryType.charAt(0).toUpperCase() + content.discoveryType.slice(1);
	DOM.append(container, $('div.chat-debug-file-list-title', undefined, localize('chatDebug.discoveryResults', "{0} Discovery Results", capitalizedType)));
	DOM.append(container, $('div.chat-debug-file-list-summary', undefined, localize('chatDebug.totalFiles', "Total files: {0}", content.files.length)));

	// Loaded files
	const loaded = content.files.filter(f => f.status === 'loaded');
	if (loaded.length > 0) {
		const section = DOM.append(container, $('div.chat-debug-file-list-section'));
		DOM.append(section, $('div.chat-debug-file-list-section-title', undefined,
			localize('chatDebug.loadedFiles', "Loaded ({0})", loaded.length)));

		for (const file of loaded) {
			const row = DOM.append(section, $('div.chat-debug-file-list-row'));
			DOM.append(row, $(`span.chat-debug-file-list-icon${ThemeIcon.asCSSSelector(Codicon.check)}`));
			const locationBadgeText = localize('chatDebug.locationBadge', " ({0})", getFileLocationLabel(file, labelService));
			// Only include location in tooltip when it's an extension ID (path would be redundant)
			const hoverSuffix = file.extensionId ? locationBadgeText.trim() : undefined;
			row.appendChild(createInlineFileLink(file.uri, file.name ?? file.uri.path, FileKind.FILE, openerService, modelService, languageService, hoverService, labelService, disposables, hoverSuffix));
			appendLocationBadge(row, file, locationBadgeText, 'chat-debug-file-list-badge', openerService, hoverService, disposables);
		}
	}

	// Skipped files
	const skipped = content.files.filter(f => f.status === 'skipped');
	if (skipped.length > 0) {
		const section = DOM.append(container, $('div.chat-debug-file-list-section'));
		DOM.append(section, $('div.chat-debug-file-list-section-title', undefined,
			localize('chatDebug.skippedFiles', "Skipped ({0})", skipped.length)));

		for (const file of skipped) {
			const row = DOM.append(section, $('div.chat-debug-file-list-row'));
			DOM.append(row, $(`span.chat-debug-file-list-icon${ThemeIcon.asCSSSelector(Codicon.close)}`));

			let reasonText = ` (${file.skipReason ?? localize('chatDebug.unknown', "unknown")}`;
			if (file.errorMessage) {
				reasonText += `: ${file.errorMessage}`;
			}
			if (file.duplicateOf) {
				reasonText += localize('chatDebug.duplicateOf', ", duplicate of {0}", file.duplicateOf.path);
			}
			reasonText += ')';
			// Only include reason in tooltip when it's an extension file (path-based location is redundant)
			const skippedHoverSuffix = file.extensionId ? reasonText.trim() : undefined;
			row.appendChild(createInlineFileLink(file.uri, file.name ?? file.uri.path, FileKind.FILE, openerService, modelService, languageService, hoverService, labelService, disposables, skippedHoverSuffix));
			appendLocationBadge(row, file, reasonText, 'chat-debug-file-list-detail', openerService, hoverService, disposables);
		}
	}

	// Source folders (paths attempted) - collapsible, initially collapsed
	if (content.sourceFolders && content.sourceFolders.length > 0) {
		const sectionEl = DOM.append(container, $('div.chat-debug-message-section'));

		const header = DOM.append(sectionEl, $('div.chat-debug-message-section-header'));

		const chevron = DOM.append(header, $('span.chat-debug-message-section-chevron'));
		DOM.append(header, $('span.chat-debug-message-section-title', undefined,
			localize('chatDebug.sourceFolders', "Sources ({0})", content.sourceFolders.length)));

		// Settings gear button on the right side of the header
		const settingsKey = getSettingsKeyForDiscoveryType(content.discoveryType);
		if (settingsKey) {
			const gearBtn = DOM.append(header, $(`span.chat-debug-settings-gear${ThemeIcon.asCSSSelector(Codicon.settingsGear)}`));
			disposables.add(hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), gearBtn, localize('chatDebug.openSettingsTooltip', "Configure locations")));
			disposables.add(DOM.addDisposableListener(gearBtn, DOM.EventType.MOUSE_ENTER, () => {
				gearBtn.classList.add('chat-debug-settings-gear-hover-active');
				header.classList.add('chat-debug-settings-gear-header-passthrough');
			}));
			disposables.add(DOM.addDisposableListener(gearBtn, DOM.EventType.MOUSE_LEAVE, () => {
				gearBtn.classList.remove('chat-debug-settings-gear-hover-active');
				header.classList.remove('chat-debug-settings-gear-header-passthrough');
			}));
			disposables.add(DOM.addDisposableListener(gearBtn, DOM.EventType.CLICK, (e) => {
				e.preventDefault();
				e.stopPropagation();
				openerService.open(URI.parse(`command:workbench.action.openSettings?${encodeURIComponent(JSON.stringify([`@id:${settingsKey}`]))}`), { allowCommands: true });
			}));
		}

		const contentEl = DOM.append(sectionEl, $('div.chat-debug-source-folder-content'));

		const capitalizedType = content.discoveryType.charAt(0).toUpperCase() + content.discoveryType.slice(1);
		const sourcesCaption = capitalizedType.endsWith('s') ? capitalizedType : capitalizedType + 's';
		DOM.append(contentEl, $('div.chat-debug-source-folder-note', undefined,
			localize('chatDebug.sourcesNote', "{0} were discovered by checking the following sources in order:", sourcesCaption)));
		for (let i = 0; i < content.sourceFolders.length; i++) {
			const folder = content.sourceFolders[i];
			const row = DOM.append(contentEl, $('div.chat-debug-source-folder-row'));
			DOM.append(row, $('span.chat-debug-source-folder-index', undefined, `${i + 1}.`));
			DOM.append(row, $('span.chat-debug-source-folder-label', undefined, folder.uri.path));
		}

		let collapsed = true;
		const updateState = () => {
			DOM.clearNode(chevron);
			const icon = collapsed ? Codicon.chevronRight : Codicon.chevronDown;
			chevron.classList.add(...ThemeIcon.asClassName(icon).split(' '));
			contentEl.style.display = collapsed ? 'none' : 'block';
		};
		updateState();

		disposables.add(DOM.addDisposableListener(header, DOM.EventType.CLICK, () => {
			collapsed = !collapsed;
			chevron.className = 'chat-debug-message-section-chevron';
			updateState();
		}));
	}

	return { element: container, disposables };
}

/**
 * Convert a file list content to plain text for clipboard / editor output.
 */
export function fileListToPlainText(content: IChatDebugEventFileListContent): string {
	const lines: string[] = [];
	const capitalizedType = content.discoveryType.charAt(0).toUpperCase() + content.discoveryType.slice(1);
	lines.push(localize('chatDebug.plainText.discoveryResults', "{0} Discovery Results", capitalizedType));
	lines.push(localize('chatDebug.plainText.totalFiles', "Total files: {0}", content.files.length));
	lines.push('');

	const loaded = content.files.filter(f => f.status === 'loaded');
	const skipped = content.files.filter(f => f.status === 'skipped');

	if (loaded.length > 0) {
		lines.push(localize('chatDebug.plainText.loaded', "Loaded ({0})", loaded.length));
		for (const f of loaded) {
			const label = f.name ?? f.uri.path;
			const locationLabel = f.extensionId ?? dirname(f.uri).path;
			lines.push(`  \u2713 ${label} - ${f.uri.path} (${locationLabel})`);
		}
		lines.push('');
	}

	if (skipped.length > 0) {
		lines.push(localize('chatDebug.plainText.skipped', "Skipped ({0})", skipped.length));
		for (const f of skipped) {
			const label = f.name ?? f.uri.path;
			const reason = f.skipReason ?? localize('chatDebug.plainText.unknown', "unknown");
			let detail = `  \u2717 ${label} (${reason}`;
			if (f.errorMessage) {
				detail += `: ${f.errorMessage}`;
			}
			if (f.duplicateOf) {
				detail += localize('chatDebug.plainText.duplicateOf', ", duplicate of {0}", f.duplicateOf.path);
			}
			detail += ')';
			lines.push(detail);
		}
	}

	if (content.sourceFolders && content.sourceFolders.length > 0) {
		lines.push('');
		lines.push(localize('chatDebug.plainText.sourceFolders', "Sources ({0})", content.sourceFolders.length));
		for (const folder of content.sourceFolders) {
			lines.push(`  ${folder.uri.path}`);
		}
	}

	return lines.join('\n');
}
