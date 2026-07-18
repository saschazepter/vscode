/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Builds the message that invokes a bundled skill.
 *
 * A skill loaded into the harness runtime (via its skill directory) is invoked
 * by a message that asks the model to use the `skill` tool to load and follow
 * it. So a `/<name>` built-in skill request is rewritten into this canonical
 * phrasing - the same contract the Copilot SDK reference client uses.
 *
 * Harness-agnostic and pure so every harness (and the unit tests) share one
 * definition of the invocation contract.
 *
 * @param skillName The bundled skill's name (its folder / `/<name>` command).
 * @param userInstructions Optional free text the user typed after the command,
 *   forwarded as additional context for the skill.
 */
export function buildSkillInvocationPrompt(skillName: string, userInstructions?: string): string {
	const base = `Use the skill tool to invoke the '${skillName}' skill, then follow the skill's instructions.`;
	const trimmed = userInstructions?.trim();
	return trimmed ? `${base}\n\nAdditional context from the user:\n${trimmed}` : base;
}
