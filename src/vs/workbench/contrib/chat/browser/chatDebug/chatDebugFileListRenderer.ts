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
 * Create a file link element styled like the chat panel's InlineAnchorWidget.
 */
function createInlineFileLink(uri: URI, displayText: string, fileKind: FileKind, openerService: IOpenerService, modelService: IModelService, languageService: ILanguageService, hoverService: IHoverService, labelService: ILabelService, disposables: DisposableStore): HTMLElement {
	const link = $(`a.${InlineAnchorWidget.className}.show-file-icons`);
	link.style.cursor = 'pointer';

	const iconEl = DOM.append(link, $('span.icon'));
	const iconClasses = getIconClasses(modelService, languageService, uri, fileKind);
	iconEl.classList.add(...iconClasses);

	DOM.append(link, $('span.icon-label', undefined, displayText));

	const relativeLabel = labelService.getUriLabel(uri, { relative: true });
	disposables.add(hoverService.setupManagedHover(getDefaultHoverDelegate('element'), link, relativeLabel));
	disposables.add(DOM.addDisposableListener(link, DOM.EventType.CLICK, (e) => {
		e.preventDefault();
		openerService.open(uri);
	}));

	return link;
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

	// Source folders
	if (content.sourceFolders && content.sourceFolders.length > 0) {
		const foldersSection = DOM.append(container, $('div.chat-debug-file-list-section'));
		DOM.append(foldersSection, $('div.chat-debug-file-list-section-title', undefined,
			localize('chatDebug.sourceFolders', "Source folders searched ({0})", content.sourceFolders.length)));

		for (const folder of content.sourceFolders) {
			const row = DOM.append(foldersSection, $('div.chat-debug-file-list-row'));

			const iconClass = folder.exists ? ThemeIcon.asCSSSelector(Codicon.check) : ThemeIcon.asCSSSelector(Codicon.close);
			DOM.append(row, $(`span.chat-debug-file-list-icon${iconClass}`));

			row.appendChild(createInlineFileLink(folder.uri, folder.uri.path, FileKind.FOLDER, openerService, modelService, languageService, hoverService, labelService, disposables));

			DOM.append(row, $('span.chat-debug-file-list-badge', undefined, ` [${folder.storage}]`));

			let detailText: string;
			if (folder.exists) {
				detailText = ` (${folder.fileCount} file(s))`;
			} else if (folder.errorMessage) {
				detailText = ` (error: ${folder.errorMessage})`;
			} else {
				detailText = localize('chatDebug.notFound', " (not found)");
			}
			DOM.append(row, $('span.chat-debug-file-list-detail', undefined, detailText));
		}
	}

	// Loaded files
	const loaded = content.files.filter(f => f.status === 'loaded');
	if (loaded.length > 0) {
		const section = DOM.append(container, $('div.chat-debug-file-list-section'));
		const sectionTitle = DOM.append(section, $('div.chat-debug-file-list-section-title'));
		DOM.append(sectionTitle, $(`span.chat-debug-file-list-status-icon.status-loaded${ThemeIcon.asCSSSelector(Codicon.check)}`));
		DOM.append(sectionTitle, $('span', undefined,
			localize('chatDebug.loadedFiles', "Loaded ({0})", loaded.length)));

		for (const file of loaded) {
			const row = DOM.append(section, $('div.chat-debug-file-list-row'));
			DOM.append(row, $(`span.chat-debug-file-list-icon${ThemeIcon.asCSSSelector(Codicon.check)}`));
			row.appendChild(createInlineFileLink(file.uri, file.name ?? file.uri.path, FileKind.FILE, openerService, modelService, languageService, hoverService, labelService, disposables));
			DOM.append(row, $('span.chat-debug-file-list-badge', undefined,
				file.extensionId ? ` [extension: ${file.extensionId}]` : ` [${file.storage}]`));
		}
	}

	// Skipped files
	const skipped = content.files.filter(f => f.status === 'skipped');
	if (skipped.length > 0) {
		const section = DOM.append(container, $('div.chat-debug-file-list-section'));
		const hasErrors = skipped.some(f => f.skipReason === 'parse-error' || f.errorMessage);
		const sectionTitle = DOM.append(section, $('div.chat-debug-file-list-section-title'));
		if (hasErrors) {
			DOM.append(sectionTitle, $(`span.chat-debug-file-list-status-icon.status-error${ThemeIcon.asCSSSelector(Codicon.error)}`));
		} else {
			DOM.append(sectionTitle, $(`span.chat-debug-file-list-status-icon.status-skipped${ThemeIcon.asCSSSelector(Codicon.debugStackframeDot)}`));
		}
		DOM.append(sectionTitle, $('span', undefined,
			localize('chatDebug.skippedFiles', "Skipped ({0})", skipped.length)));

		for (const file of skipped) {
			const row = DOM.append(section, $('div.chat-debug-file-list-row'));
			DOM.append(row, $(`span.chat-debug-file-list-icon${ThemeIcon.asCSSSelector(Codicon.close)}`));
			row.appendChild(createInlineFileLink(file.uri, file.name ?? file.uri.path, FileKind.FILE, openerService, modelService, languageService, hoverService, labelService, disposables));

			let reasonText = ` (${file.skipReason ?? 'unknown'}`;
			if (file.errorMessage) {
				reasonText += `: ${file.errorMessage}`;
			}
			if (file.duplicateOf) {
				reasonText += `, duplicate of ${file.duplicateOf.path}`;
			}
			reasonText += ')';
			DOM.append(row, $('span.chat-debug-file-list-detail', undefined, reasonText));
		}
	}

	return { element: container, disposables };
}

/**
 * Convert a file list content to plain text for clipboard / editor output.
 */
export function fileListToPlainText(content: IChatDebugEventFileListContent): string {
	const lines: string[] = [];
	const capitalizedType = content.discoveryType.charAt(0).toUpperCase() + content.discoveryType.slice(1);
	lines.push(`${capitalizedType} Discovery Results`);
	lines.push(`Total files: ${content.files.length}`);
	lines.push('');

	if (content.sourceFolders && content.sourceFolders.length > 0) {
		lines.push(`Source folders searched (${content.sourceFolders.length})`);
		for (const folder of content.sourceFolders) {
			const statusIcon = folder.exists ? '\u2713' : '\u2717';
			let detail = `  ${statusIcon} ${folder.uri.path} [${folder.storage}]`;
			if (folder.exists) {
				detail += ` (${folder.fileCount} file(s))`;
			} else if (folder.errorMessage) {
				detail += ` (error: ${folder.errorMessage})`;
			} else {
				detail += ' (not found)';
			}
			lines.push(detail);
		}
		lines.push('');
	}

	const loaded = content.files.filter(f => f.status === 'loaded');
	const skipped = content.files.filter(f => f.status === 'skipped');

	if (loaded.length > 0) {
		lines.push(`Loaded (${loaded.length})`);
		for (const f of loaded) {
			const label = f.name ?? f.uri.path;
			const storageSuffix = f.extensionId ? ` [extension: ${f.extensionId}]` : ` [${f.storage}]`;
			lines.push(`  \u2713 ${label} - ${f.uri.path}${storageSuffix}`);
		}
		lines.push('');
	}

	if (skipped.length > 0) {
		lines.push(`Skipped (${skipped.length})`);
		for (const f of skipped) {
			const label = f.name ?? f.uri.path;
			const reason = f.skipReason ?? 'unknown';
			let detail = `  \u2717 ${label} (${reason}`;
			if (f.errorMessage) {
				detail += `: ${f.errorMessage}`;
			}
			if (f.duplicateOf) {
				detail += `, duplicate of ${f.duplicateOf.path}`;
			}
			detail += ')';
			lines.push(detail);
		}
	}

	return lines.join('\n');
}
