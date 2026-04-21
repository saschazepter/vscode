/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { ICustomInstructionsService } from '../../../platform/customInstructions/common/customInstructionsService';
import { TextDocumentSnapshot } from '../../../platform/editing/common/textDocumentSnapshot';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger } from '../../../platform/requestLogger/common/requestLogger';
import { getCurrentCapturingToken } from '../../../platform/requestLogger/node/requestLogger';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { extUriBiasedIgnorePathCase } from '../../../util/vs/base/common/resources';
import { isString } from '../../../util/vs/base/common/types';
import { URI } from '../../../util/vs/base/common/uri';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseNotebookEditPart, ChatResponseTextEditPart, ChatToolInvocationPart, ExtendedLanguageModelToolResult, LanguageModelTextPart, MarkdownString } from '../../../vscodeTypes';
import { isCustomizationsIndex } from '../../prompt/common/chatVariablesCollection';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { SkillSubagentToolCallingLoop } from '../../prompt/node/skillSubagentToolCallingLoop';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { formatUriForFileWidget } from '../common/toolUtils';

export interface ILoadSkillParams {
	/** The skill name. E.g., "commit", "review-pr", or "pdf" */
	skill: string;
}

const DEFAULT_SKILL_SUBAGENT_TOOL_CALL_LIMIT = 10;

/** Maximum number of related files to list in skill context */
const MAX_RELATED_FILES = 50;

/** Directories to skip when listing related files */
const SKILL_SKIP_DIRS = new Set([
	'.git', 'node_modules', 'dist', 'build', 'out', '.cache',
	'coverage', '__pycache__', 'target', 'bin', 'obj', '.venv', 'venv',
]);

class LoadSkillTool implements ICopilotTool<ILoadSkillParams> {
	public static readonly toolName = ToolName.LoadSkill;
	public static readonly nonDeferred = true;
	private _inputContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@ICustomInstructionsService private readonly customInstructionsService: ICustomInstructionsService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IPromptPathRepresentationService _promptPathRepresentationService: IPromptPathRepresentationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ILoadSkillParams>, token: vscode.CancellationToken) {
		const uri = this.resolveSkillUri(options.input.skill);

		// Read the skill file content
		const document = await this.workspaceService.openTextDocument(uri);
		const snapshot = TextDocumentSnapshot.create(document);
		const skillContent = snapshot.getText();

		const mode = parseSkillContext(skillContent);

		if (mode === 'fork') {
			return this.invokeFork(skillContent, uri, options, token);
		} else {
			return this.invokeInline(skillContent, uri);
		}
	}

	private async invokeInline(skillContent: string, uri: URI) {
		const skillInfo = this.customInstructionsService.getSkillInfo(uri);
		const skillLabel = skillInfo?.skillName ?? 'skill';
		const skillFolderUri = skillInfo?.skillFolderUri ?? extUriBiasedIgnorePathCase.dirname(uri);

		// List related files in the skill directory
		const relatedFiles = await this.listRelatedFiles(skillFolderUri);
		const relatedFilesSection = relatedFiles.length > 0
			? `\nRelated files (use read_file tool to read):\n${relatedFiles.map(f => `  - ${f}`).join('\n')}\n`
			: '';

		const resultText = `<skill-context name="${skillLabel}">
Base directory: ${skillFolderUri.fsPath}
${relatedFilesSection}
${skillContent}
</skill-context>`;

		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(resultText)]);
		result.toolResultMessage = new MarkdownString(l10n.t`Loaded skill: ${skillLabel}`);
		result.toolMetadata = {
			skill: skillLabel,
			skillUri: uri.toString(),
			agentName: 'skill'
		};
		return result;
	}

	private async invokeFork(skillContent: string, uri: URI, options: vscode.LanguageModelToolInvocationOptions<ILoadSkillParams>, token: vscode.CancellationToken) {
		if (!this._inputContext) {
			throw new Error('LoadSkillTool: _inputContext is not set. Ensure resolveInput is called before invoke.');
		}

		const skillInfo = this.customInstructionsService.getSkillInfo(uri);
		const skillLabel = skillInfo?.skillName ?? options.input.skill;

		// Use the user's original message as the task for the subagent
		const userMessage = this._inputContext.conversation?.turns[0]?.request.message;
		const query = userMessage ?? `Run the ${skillLabel} skill`;

		const request = this._inputContext.request!;
		const parentSessionId = this._inputContext.conversation?.sessionId ?? generateUuid();
		const subAgentInvocationId = generateUuid();

		const loop = this.instantiationService.createInstance(SkillSubagentToolCallingLoop, {
			toolCallLimit: DEFAULT_SKILL_SUBAGENT_TOOL_CALL_LIMIT,
			conversation: new Conversation(parentSessionId, [new Turn(generateUuid(), { type: 'user', message: query })]),
			request,
			location: request.location,
			promptText: query,
			skillInstructions: skillContent,
			subAgentInvocationId,
		});

		const stream = this._inputContext?.stream && ChatResponseStreamImpl.filter(
			this._inputContext.stream,
			part => part instanceof ChatToolInvocationPart || part instanceof ChatResponseTextEditPart || part instanceof ChatResponseNotebookEditPart
		);

		const parentChatSessionId = getCurrentCapturingToken()?.chatSessionId;
		const skillSubagentToken = new CapturingToken(
			`Skill: ${skillLabel}`,
			'skill',
			subAgentInvocationId,
			'skill',
			subAgentInvocationId,
			parentChatSessionId,
			'skillSubagent',
		);

		const loopResult = await this.requestLogger.captureInvocation(skillSubagentToken, () => loop.run(stream, token));

		const toolMetadata = {
			skill: options.input.skill,
			skillUri: uri.toString(),
			subAgentInvocationId,
			agentName: 'skill'
		};

		let subagentResponse = '';
		if (loopResult.response.type === ChatFetchResponseType.Success) {
			subagentResponse = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
		} else {
			subagentResponse = `The skill subagent request failed with this message:\n${loopResult.response.type}: ${loopResult.response.reason}`;
		}

		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(subagentResponse)]);
		result.toolMetadata = toolMetadata;
		result.toolResultMessage = new MarkdownString(l10n.t`Skill complete: ${skillLabel}`);
		return result;
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ILoadSkillParams>, _token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation | undefined> {
		let uri: URI;
		try {
			uri = this.resolveSkillUri(options.input.skill);
		} catch {
			return {
				invocationMessage: new MarkdownString(l10n.t`Loading skill: ${options.input.skill}`),
			};
		}

		await this.customInstructionsService.refreshExtensionPromptFiles();
		const skillInfo = this.customInstructionsService.getSkillInfo(uri);
		const skillLabel = skillInfo?.skillName ?? options.input.skill;

		// Read the skill file to check frontmatter for context: fork
		const document = await this.workspaceService.openTextDocument(uri);
		const snapshot = TextDocumentSnapshot.create(document);
		const mode = parseSkillContext(snapshot.getText());

		if (mode === 'fork') {
			return {
				invocationMessage: new MarkdownString(l10n.t`Running skill ${formatUriForFileWidget(uri, { vscodeLinkType: 'skill', linkText: skillLabel })}`),
				pastTenseMessage: new MarkdownString(l10n.t`Ran skill ${formatUriForFileWidget(uri, { vscodeLinkType: 'skill', linkText: skillLabel })}`),
			};
		}

		return {
			invocationMessage: new MarkdownString(l10n.t`Loading skill ${formatUriForFileWidget(uri, { vscodeLinkType: 'skill', linkText: skillLabel })}`),
			pastTenseMessage: new MarkdownString(l10n.t`Loaded skill ${formatUriForFileWidget(uri, { vscodeLinkType: 'skill', linkText: skillLabel })}`),
		};
	}

	async resolveInput(input: ILoadSkillParams, promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<ILoadSkillParams> {
		this._inputContext = promptContext;
		return input;
	}

	/**
	 * Resolve a skill name to its SKILL.md URI by searching the instruction index.
	 * If not found, throws with a list of available skills.
	 */
	private resolveSkillUri(skillName: string): URI {
		const availableSkills: string[] = [];

		if (this._inputContext) {
			const indexVariable = this._inputContext.chatVariables.find(isCustomizationsIndex);
			if (indexVariable && isString(indexVariable.value)) {
				const indexFile = this.customInstructionsService.parseInstructionIndexFile(indexVariable.value);
				for (const skillUri of indexFile.skills) {
					const info = this.customInstructionsService.getSkillInfo(skillUri);
					if (info) {
						if (info.skillName === skillName) {
							return skillUri;
						}
						availableSkills.push(info.skillName);
					}
				}
			}
		}

		const skillListMessage = availableSkills.length > 0
			? ` Available skills: ${availableSkills.join(', ')}`
			: '';
		throw new Error(`Skill "${skillName}" not found.${skillListMessage}`);
	}

	/**
	 * List files in a skill directory, excluding SKILL.md and skipped directories.
	 */
	private async listRelatedFiles(skillFolderUri: URI): Promise<string[]> {
		try {
			const files: string[] = [];
			await this.listRelatedFilesRecursive(skillFolderUri, skillFolderUri, files);
			return files;
		} catch {
			return [];
		}
	}

	private async listRelatedFilesRecursive(baseUri: URI, currentUri: URI, files: string[], depth: number = 0): Promise<void> {
		if (files.length >= MAX_RELATED_FILES || depth > 5) {
			return;
		}

		const entries = await this.fileSystemService.readDirectory(currentUri);

		for (const [name, type] of entries) {
			if (files.length >= MAX_RELATED_FILES) {
				break;
			}

			if (type === FileType.Directory) {
				if (!SKILL_SKIP_DIRS.has(name)) {
					await this.listRelatedFilesRecursive(baseUri, extUriBiasedIgnorePathCase.joinPath(currentUri, name), files, depth + 1);
				}
			} else if (type === FileType.File && name.toUpperCase() !== 'SKILL.MD') {
				const relativePath = extUriBiasedIgnorePathCase.relativePath(baseUri, extUriBiasedIgnorePathCase.joinPath(currentUri, name));
				if (relativePath) {
					files.push(relativePath);
				}
			}
		}
	}
}

ToolRegistry.registerTool(LoadSkillTool);

/**
 * Parse the `context` field from SKILL.md YAML frontmatter.
 * Returns 'fork' if frontmatter contains `context: fork`, otherwise 'inline'.
 */
function parseSkillContext(content: string): 'inline' | 'fork' {
	const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/m);
	if (!frontmatterMatch) {
		return 'inline';
	}
	const contextMatch = frontmatterMatch[1].match(/^context:\s*(.+)$/m);
	if (contextMatch && contextMatch[1].trim() === 'fork') {
		return 'fork';
	}
	return 'inline';
}
