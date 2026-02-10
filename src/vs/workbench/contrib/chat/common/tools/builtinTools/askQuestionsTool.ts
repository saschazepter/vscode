/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import {
	DeferredPromise,
	raceCancellation,
} from '../../../../../../base/common/async.js';
import {
	Disposable,
	DisposableStore,
} from '../../../../../../base/common/lifecycle.js';
import {
	IJSONSchema,
	IJSONSchemaMap,
} from '../../../../../../base/common/jsonSchema.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import {
	IChatQuestion,
	IChatQuestionCarousel,
	IChatService,
} from '../../chatService/chatService.js';
import { ChatModel } from '../../model/chatModel.js';
import {
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolResult,
	ToolDataSource,
	IToolInvocationPreparationContext,
	IPreparedToolInvocation,
	CountTokensCallback,
	ToolProgress,
	ToolInvocationPresentation,
} from '../languageModelToolsService.js';

export const AskQuestionsToolId = 'ask_questions';

export function createAskQuestionsToolData(): IToolData {
	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			questions: {
				type: 'array',
				description: 'Array of 1-4 questions to ask the user',
				minItems: 1,
				maxItems: 4,
				items: {
					type: 'object',
					properties: {
						header: {
							type: 'string',
							maxLength: 12,
							description: 'A short label (max 12 chars) displayed as a quick pick header, also used as the unique identifier for the question'
						},
						question: {
							type: 'string',
							description: 'The complete question text to display'
						},
						multiSelect: {
							type: 'boolean',
							default: false,
							description: 'Allow multiple selections'
						},
						options: {
							type: 'array',
							minItems: 0,
							maxItems: 6,
							description: '0-6 options for the user to choose from. If empty or omitted, shows a free text input instead.',
							items: {
								type: 'object',
								properties: {
									label: {
										type: 'string',
										description: 'Option label text'
									},
									description: {
										type: 'string',
										description: 'Optional description for the option'
									},
									recommended: {
										type: 'boolean',
										description: 'Mark this option as recommended'
									}
								},
								required: ['label']
							}
						},
						allowFreeformInput: {
							type: 'boolean',
							default: false,
							description: 'When true, allows user to enter free-form text in addition to selecting options. Use when the user\'s opinion or custom input would be valuable.'
						}
					},
					required: ['header', 'question']
				}
			}
		},
		required: ['questions']
	};

	return {
		id: AskQuestionsToolId,
		toolReferenceName: 'askQuestions',
		legacyToolReferenceFullNames: ['copilot_askQuestions'],
		canBeReferencedInPrompt: true,
		icon: ThemeIcon.fromId(Codicon.question.id),
		displayName: localize(
			"tool.askQuestions.displayName",
			"Ask the user questions",
		),
		userDescription: localize(
			"tool.askQuestions.userDescription",
			"Ask the user questions to clarify intent or gather information",
		),
		modelDescription: `Ask the user questions to clarify intent, validate assumptions, or choose between implementation approaches. Prefer proposing a sensible default so users can confirm quickly.

Only use this tool when the user's answer provides information you cannot determine or reasonably assume yourself. This tool is for gathering information, not for reporting status or problems. If a question has an obvious best answer, take that action instead of asking.

When to use:
- Clarify ambiguous requirements before proceeding
- Get user preferences on implementation choices
- Confirm decisions that meaningfully affect outcome

When NOT to use:
- The answer is determinable from code or context
- Asking for permission to continue or abort
- Confirming something you can reasonably decide yourself
- Reporting a problem (instead, attempt to resolve it)

Question guidelines:
- NEVER use \`recommended\` for quizzes or polls. Recommended options are PRE-SELECTED and visible to users, which would reveal answers
- Batch related questions into a single call (max 4 questions, 2-6 options each; omit options for free text input)
- Provide brief context explaining what is being decided and why
- Only mark an option as \`recommended\` with a short justification to suggest YOUR preferred implementation choice
- Keep options mutually exclusive for single-select; use \`multiSelect: true\` only when choices are additive and phrase the question accordingly

After receiving answers:
- Incorporate decisions and continue without re-asking unless requirements change

An "Other" option is automatically shown to users - do not add your own.`,
		source: ToolDataSource.Internal,
		inputSchema: inputSchema,
	};
}

export const AskQuestionsToolData: IToolData = createAskQuestionsToolData();

interface IQuestionOption {
	label: string;
	description?: string;
	recommended?: boolean;
}

interface IQuestion {
	header: string;
	question: string;
	multiSelect?: boolean;
	options?: IQuestionOption[];
	allowFreeformInput?: boolean;
}

interface IAskQuestionsToolInputParams {
	questions: IQuestion[];
}

interface IQuestionAnswer {
	selected: string[];
	freeText: string | null;
	skipped: boolean;
}

interface IAnswerResult {
	answers: Record<string, IQuestionAnswer>;
}

interface IAnswerObject {
	freeformValue?: string;
	selectedValue?: unknown;
	selectedValues?: unknown[];
	label?: string;
}

function isAnswerObject(value: unknown): value is IAnswerObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AskQuestionsTool extends Disposable implements IToolImpl {
	constructor(
		@IChatService private readonly chatService: IChatService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();
	}

	async prepareToolInvocation(
		context: IToolInvocationPreparationContext,
		_token: CancellationToken,
	): Promise<IPreparedToolInvocation | undefined> {
		const args = context.parameters as IAskQuestionsToolInputParams;
		const { questions } = args;

		// Validate input
		if (!questions || questions.length === 0) {
			throw new Error(
				localize(
					"askQuestions.noQuestions",
					"No questions provided. The questions array must contain at least one question.",
				),
			);
		}

		for (const question of questions) {
			// Options with 1 item don't make sense - need 0 (free text) or 2+ (choice)
			if (question.options && question.options.length === 1) {
				throw new Error(
					localize(
						"askQuestions.invalidOptions",
						'Question "{0}" must have at least two options, or none for free text input.',
						question.header,
					),
				);
			}
		}

		const questionCount = questions.length;
		const headers = questions.map((q) => q.header).join(', ');
		const message =
			questionCount === 1
				? localize(
					"askQuestions.asking.single",
					"Asking a question ({0})",
					headers,
				)
				: localize(
					"askQuestions.asking.multiple",
					"Asking {0} questions ({1})",
					questionCount,
					headers,
				);
		const pastMessage =
			questionCount === 1
				? localize(
					"askQuestions.asked.single",
					"Asked a question ({0})",
					headers,
				)
				: localize(
					"askQuestions.asked.multiple",
					"Asked {0} questions ({1})",
					questionCount,
					headers,
				);

		return {
			invocationMessage: new MarkdownString(message),
			pastTenseMessage: new MarkdownString(pastMessage),
			presentation: ToolInvocationPresentation.HiddenAfterComplete,
		};
	}

	async invoke(
		invocation: IToolInvocation,
		_countTokens: CountTokensCallback,
		_progress: ToolProgress,
		token: CancellationToken,
	): Promise<IToolResult> {
		const startTime = Date.now();
		const args = invocation.parameters as IAskQuestionsToolInputParams;
		const { questions } = args;

		this.logService.trace(
			`[AskQuestionsTool] Invoking with ${questions.length} question(s)`,
		);

		if (!invocation.context) {
			// No session context - return with all questions skipped
			this.logService.warn(
				'[AskQuestionsTool] No context available, cannot show question carousel',
			);
			const skippedAnswers: Record<string, IQuestionAnswer> = {};
			for (const question of questions) {
				skippedAnswers[question.header] = {
					selected: [],
					freeText: null,
					skipped: true,
				};
			}
			return this.createToolResult({ answers: skippedAnswers });
		}

		// Get the chat model and request
		const model = this.chatService.getSession(
			invocation.context.sessionResource,
		) as ChatModel | undefined;
		if (!model) {
			this.logService.warn(
				'[AskQuestionsTool] Chat model not found for session',
			);
			const skippedAnswers: Record<string, IQuestionAnswer> = {};
			for (const question of questions) {
				skippedAnswers[question.header] = {
					selected: [],
					freeText: null,
					skipped: true,
				};
			}
			return this.createToolResult({ answers: skippedAnswers });
		}

		const request = model.getRequests().at(-1);
		if (!request) {
			this.logService.warn('[AskQuestionsTool] No request found in session');
			const skippedAnswers: Record<string, IQuestionAnswer> = {};
			for (const question of questions) {
				skippedAnswers[question.header] = {
					selected: [],
					freeText: null,
					skipped: true,
				};
			}
			return this.createToolResult({ answers: skippedAnswers });
		}

		// Convert questions to IChatQuestion format
		const chatQuestions = questions.map((q) => this.convertToChatQuestion(q));

		// Generate unique resolve ID
		const resolveId = generateUuid();

		// Create the question carousel progress part
		const carousel: IChatQuestionCarousel = {
			kind: 'questionCarousel',
			questions: chatQuestions,
			allowSkip: true,
			resolveId: resolveId,
		};

		// Create a deferred promise to wait for the answer
		const deferred = new DeferredPromise<Record<string, unknown> | undefined>();

		// Set up listener before pushing progress
		const store = new DisposableStore();
		store.add(
			this.chatService.onDidReceiveQuestionCarouselAnswer((e) => {
				if (e.resolveId === resolveId) {
					this.logService.trace(
						`[AskQuestionsTool] Received carousel answer for resolveId: ${resolveId}`,
					);
					deferred.complete(e.answers);
				}
			}),
		);

		try {
			// Push the carousel to the chat response
			model.acceptResponseProgress(request, carousel);

			// Wait for the user to submit answers, respecting cancellation
			const carouselAnswers = await raceCancellation(deferred.p, token);

			this.logService.trace(
				`[AskQuestionsTool] Raw carousel answers: ${JSON.stringify(carouselAnswers)}`,
			);

			// Convert carousel answers back to IAnswerResult format
			const result = this.convertCarouselAnswers(questions, carouselAnswers);
			this.logService.trace(
				`[AskQuestionsTool] Converted result: ${JSON.stringify(result)}`,
			);

			// Send telemetry
			const duration = Date.now() - startTime;
			this.sendTelemetry(invocation.chatRequestId, questions, result, duration);

			return this.createToolResult(result);
		} finally {
			store.dispose();
		}
	}

	private convertToChatQuestion(question: IQuestion): IChatQuestion {
		// Determine question type based on options and multiSelect
		let type: 'text' | 'singleSelect' | 'multiSelect';
		if (!question.options || question.options.length === 0) {
			type = 'text';
		} else if (question.multiSelect) {
			type = 'multiSelect';
		} else {
			type = 'singleSelect';
		}

		// Find default value from recommended option
		let defaultValue: string | string[] | undefined;
		if (question.options) {
			const recommendedOptions = question.options.filter(
				(opt) => opt.recommended,
			);
			if (recommendedOptions.length > 0) {
				if (question.multiSelect) {
					defaultValue = recommendedOptions.map((opt) => opt.label);
				} else {
					defaultValue = recommendedOptions[0].label;
				}
			}
		}

		return {
			id: question.header,
			type,
			title: question.header,
			message: question.question,
			options: question.options?.map((opt) => ({
				id: opt.label,
				label: opt.description
					? `${opt.label} - ${opt.description}`
					: opt.label,
				value: opt.label,
			})),
			defaultValue,
			allowFreeformInput: question.allowFreeformInput ?? false,
		};
	}

	private convertCarouselAnswers(
		questions: IQuestion[],
		carouselAnswers: Record<string, unknown> | undefined,
	): IAnswerResult {
		const result: IAnswerResult = { answers: {} };

		for (const question of questions) {
			if (!carouselAnswers) {
				// User skipped all questions
				result.answers[question.header] = {
					selected: [],
					freeText: null,
					skipped: true,
				};
				continue;
			}

			const answer = carouselAnswers[question.header];

			if (answer === undefined) {
				result.answers[question.header] = {
					selected: [],
					freeText: null,
					skipped: true,
				};
			} else if (typeof answer === 'string') {
				// Free text answer or single selection
				if (question.options?.some((opt) => opt.label === answer)) {
					result.answers[question.header] = {
						selected: [answer],
						freeText: null,
						skipped: false,
					};
				} else {
					result.answers[question.header] = {
						selected: [],
						freeText: answer,
						skipped: false,
					};
				}
			} else if (Array.isArray(answer)) {
				// Multi-select answer
				result.answers[question.header] = {
					selected: answer.map((a) => String(a)),
					freeText: null,
					skipped: false,
				};
			} else if (isAnswerObject(answer)) {
				// Handle object answers - VS Code returns { selectedValue: string } or { selectedValues: string[] }
				// Also may include { freeformValue: string } when user enters free text with options
				const answerObj = answer;

				// Extract freeform text if present (treat empty string as no freeform)
				const freeformValue =
					typeof answerObj.freeformValue === 'string' && answerObj.freeformValue
						? answerObj.freeformValue
						: null;

				if (Array.isArray(answerObj.selectedValues)) {
					// Multi-select answer
					result.answers[question.header] = {
						selected: answerObj.selectedValues.map((v) => String(v)),
						freeText: freeformValue,
						skipped: false,
					};
				} else if (answerObj.selectedValue !== undefined) {
					const value = answerObj.selectedValue;
					if (typeof value === 'string') {
						if (question.options?.some((opt) => opt.label === value)) {
							result.answers[question.header] = {
								selected: [value],
								freeText: freeformValue,
								skipped: false,
							};
						} else {
							// selectedValue is not a known option - treat it as free text
							result.answers[question.header] = {
								selected: [],
								freeText: freeformValue ?? value,
								skipped: false,
							};
						}
					} else if (Array.isArray(value)) {
						result.answers[question.header] = {
							selected: value.map((v) => String(v)),
							freeText: freeformValue,
							skipped: false,
						};
					} else if (value === undefined || value === null) {
						// No selection made, but might have freeform text
						if (freeformValue) {
							result.answers[question.header] = {
								selected: [],
								freeText: freeformValue,
								skipped: false,
							};
						} else {
							result.answers[question.header] = {
								selected: [],
								freeText: null,
								skipped: true,
							};
						}
					} else {
						result.answers[question.header] = {
							selected: [],
							freeText: null,
							skipped: true,
						};
					}
				} else if (freeformValue) {
					// Only freeform text provided, no selection
					result.answers[question.header] = {
						selected: [],
						freeText: freeformValue,
						skipped: false,
					};
				} else if (typeof answerObj.label === 'string') {
					// Answer might be the raw option object
					result.answers[question.header] = {
						selected: [answerObj.label],
						freeText: null,
						skipped: false,
					};
				} else {
					// Unknown object format
					this.logService.warn(
						`[AskQuestionsTool] Unknown answer object format for "${question.header}": ${JSON.stringify(answer)}`,
					);
					result.answers[question.header] = {
						selected: [],
						freeText: null,
						skipped: true,
					};
				}
			} else {
				// Unknown format, treat as skipped
				this.logService.warn(
					`[AskQuestionsTool] Unknown answer format for "${question.header}": ${typeof answer}`,
				);
				result.answers[question.header] = {
					selected: [],
					freeText: null,
					skipped: true,
				};
			}
		}

		return result;
	}

	private createToolResult(result: IAnswerResult): IToolResult {
		const toolResultJson = JSON.stringify(result);
		return {
			content: [
				{
					kind: 'text',
					value: toolResultJson
				}
			]
		};
	}

	private sendTelemetry(
		requestId: string | undefined,
		questions: IQuestion[],
		result: IAnswerResult,
		duration: number,
	): void {
		const answers = Object.values(result.answers);
		const answeredCount = answers.filter((a) => !a.skipped).length;
		const skippedCount = answers.filter((a) => a.skipped).length;
		const freeTextCount = answers.filter((a) => a.freeText !== null).length;
		const recommendedAvailableCount = questions.filter((q) =>
			q.options?.some((opt) => opt.recommended),
		).length;
		const recommendedSelectedCount = questions.filter((q) => {
			const answer = result.answers[q.header];
			const recommendedOption = q.options?.find((opt) => opt.recommended);
			return (
				answer &&
				!answer.skipped &&
				recommendedOption &&
				answer.selected.includes(recommendedOption.label)
			);
		}).length;

		type AskQuestionsToolInvokedEvent = {
			requestId: string | undefined;
			questionCount: number;
			answeredCount: number;
			skippedCount: number;
			freeTextCount: number;
			recommendedAvailableCount: number;
			recommendedSelectedCount: number;
			duration: number;
		};

		type AskQuestionsToolInvokedClassification = {
			requestId: {
				classification: 'SystemMetaData';
				purpose: 'FeatureInsight';
				comment: 'The id of the current request turn.';
			};
			questionCount: {
				classification: 'SystemMetaData';
				purpose: 'FeatureInsight';
				isMeasurement: true;
				comment: 'The total number of questions asked';
			};
			answeredCount: {
				classification: 'SystemMetaData';
				purpose: 'FeatureInsight';
				isMeasurement: true;
				comment: 'The number of questions that were answered';
			};
			skippedCount: {
				classification: 'SystemMetaData';
				purpose: 'FeatureInsight';
				isMeasurement: true;
				comment: 'The number of questions that were skipped';
			};
			freeTextCount: {
				classification: 'SystemMetaData';
				purpose: 'FeatureInsight';
				isMeasurement: true;
				comment: 'The number of questions answered with free text input';
			};
			recommendedAvailableCount: {
				classification: 'SystemMetaData';
				purpose: 'FeatureInsight';
				isMeasurement: true;
				comment: 'The number of questions that had a recommended option';
			};
			recommendedSelectedCount: {
				classification: 'SystemMetaData';
				purpose: 'FeatureInsight';
				isMeasurement: true;
				comment: 'The number of questions where the user selected the recommended option';
			};
			duration: {
				classification: 'SystemMetaData';
				purpose: 'PerformanceAndHealth';
				isMeasurement: true;
				comment: 'The total time in milliseconds to complete all questions';
			};
			owner: 'digitarald';
			comment: 'Tracks usage of the AskQuestions tool for agent clarifications';
		};

		this.telemetryService.publicLog2<
			AskQuestionsToolInvokedEvent,
			AskQuestionsToolInvokedClassification
		>('askQuestionsToolInvoked', {
			requestId,
			questionCount: questions.length,
			answeredCount,
			skippedCount,
			freeTextCount,
			recommendedAvailableCount,
			recommendedSelectedCount,
			duration,
		});
	}
}
