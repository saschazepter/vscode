/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { parse as parseJSONC } from '../../../../../base/common/json.js';
import { Schemas } from '../../../../../base/common/network.js';
import { OS } from '../../../../../base/common/platform.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IAICustomizationWorkspaceService } from '../../common/aiCustomizationWorkspaceService.js';
import { HOOK_METADATA } from '../../common/promptSyntax/hookTypes.js';
import { parseHooksFromFile } from '../../common/promptSyntax/hookCompatibility.js';
import { formatHookCommandLabel } from '../../common/promptSyntax/hookSchema.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { IExternalCustomizationItem } from '../../common/customizationHarnessService.js';

/**
 * Returns true if the given extension identifier matches the default
 * chat extension (e.g. GitHub Copilot Chat). Used to group items from
 * the chat extension under "Built-in" instead of "Extensions".
 */
export function isChatExtensionItem(extensionId: ExtensionIdentifier, productService: IProductService): boolean {
	const chatExtensionId = productService.defaultChatAgent?.chatExtensionId;
	return !!chatExtensionId && ExtensionIdentifier.equals(extensionId, chatExtensionId);
}

/**
 * Derives a friendly name from a filename by removing extension suffixes.
 */
export function getFriendlyName(filename: string): string {
	// Remove common prompt file extensions like .instructions.md, .prompt.md, etc.
	let name = filename
		.replace(/\.instructions\.md$/i, '')
		.replace(/\.prompt\.md$/i, '')
		.replace(/\.agent\.md$/i, '')
		.replace(/\.md$/i, '');

	// Convert kebab-case or snake_case to Title Case
	name = name
		.replace(/[-_]/g, ' ')
		.replace(/\b\w/g, c => c.toUpperCase());

	return name || filename;
}

/**
 * Expands hook file items into individual hook entries by parsing hook
 * definitions from the file content. Falls back to the original item
 * when parsing fails.
 */
export async function expandHookFileItems(
	hookFileItems: readonly IExternalCustomizationItem[],
	workspaceService: IAICustomizationWorkspaceService,
	fileService: IFileService,
	pathService: IPathService,
): Promise<IExternalCustomizationItem[]> {
	const items: IExternalCustomizationItem[] = [];
	const activeRoot = workspaceService.getActiveProjectRoot();
	const userHomeUri = await pathService.userHome();
	const userHome = userHomeUri.scheme === Schemas.file ? userHomeUri.fsPath : userHomeUri.path;

	for (const item of hookFileItems) {
		let parsedHooks = false;
		try {
			const content = await fileService.readFile(item.uri);
			const json = parseJSONC(content.value.toString());
			const { hooks } = parseHooksFromFile(item.uri, json, activeRoot, userHome);

			if (hooks.size > 0) {
				parsedHooks = true;
				for (const [hookType, entry] of hooks) {
					const hookMeta = HOOK_METADATA[hookType];
					for (let i = 0; i < entry.hooks.length; i++) {
						const hook = entry.hooks[i];
						const cmdLabel = formatHookCommandLabel(hook, OS);
						const truncatedCmd = cmdLabel.length > 60 ? cmdLabel.substring(0, 57) + '...' : cmdLabel;
						items.push({
							uri: item.uri,
							type: PromptsType.hook,
							name: hookMeta?.label ?? entry.originalId,
							description: truncatedCmd || localize('hookUnset', "(unset)"),
							enabled: item.enabled,
							groupKey: item.groupKey,
						});
					}
				}
			}
		} catch {
			// Parse failed — fall through to show raw file.
		}

		if (!parsedHooks) {
			items.push(item);
		}
	}

	return items;
}
