/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Id of the per-widget contribution that owns the prompt timeline rail. */
export const PROMPT_TIMELINE_CONTRIB_ID = 'sessions.promptTimeline';

/** Setting that controls whether the prompt timeline rail is shown in the Agents window. */
export const PROMPT_TIMELINE_ENABLED_SETTING = 'sessions.promptTimeline.enabled';

/** Setting that selects the rail's visual style. */
export const PROMPT_TIMELINE_STYLE_SETTING = 'sessions.promptTimeline.style';

/** The available prompt timeline rail styles. */
export const enum PromptTimelineStyle {
	/** Dense pills that expand on hover/focus. */
	Compact = 'compact',
	/** A proportional overview ruler with a viewport thumb. */
	Overview = 'overview',
}

/** Minimum number of user prompts before the rail is shown. */
export const MIN_PROMPTS = 2;

export const enum PromptTimelineCommandId {
	GoToNext = 'sessions.promptTimeline.goToNextPrompt',
	GoToPrevious = 'sessions.promptTimeline.goToPreviousPrompt',
	GoToPrompt = 'sessions.promptTimeline.goToPrompt',
	ReviewChanges = 'sessions.promptTimeline.reviewChanges',
}
