/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function getCopilotCLIModelIdAliases(modelId: string): readonly string[] {
	const aliases = new Set<string>();
	const addAlias = (alias: string) => {
		aliases.add(alias);
		aliases.add(alias.toLowerCase());
	};

	const trimmed = modelId.trim();
	addAlias(trimmed);

	const normalized = trimmed.toLowerCase();
	addAlias(normalized.replace(/(\d)([.-])(\d)(?=$|-)/g, (_match, before: string, separator: string, after: string) => `${before}${separator === '.' ? '-' : '.'}${after}`));

	return [...aliases];
}

export function copilotCLIModelIdEquals(a: string, b: string): boolean {
	const aliases = new Set(getCopilotCLIModelIdAliases(a));
	return getCopilotCLIModelIdAliases(b).some(alias => aliases.has(alias));
}
