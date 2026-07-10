/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';

/**
 * Presentation variants for the out-of-workspace files that an agent session
 * touches ("external changes"). These files live outside the folder associated
 * with the current workspace, so they are surfaced separately from the committed
 * {@link ISession.changes}. This spike lets us compare, at runtime, two ways of
 * making it clear that the files are located elsewhere but are still part of the
 * agent's suggestions.
 *
 * Switch between them with the developer command
 * `Developer: Cycle Agent External Changes Presentation (A/B)`.
 */
export enum ExternalChangesPresentation {
	/**
	 * Variant A. An enriched flat list in the dedicated "Changes Outside This
	 * Workspace" section: every row shows the file name plus a dimmed parent
	 * folder location and an external-location badge, with a persistent footer
	 * note clarifying the files are part of the agent's suggestions but are not
	 * committed.
	 */
	EnrichedSection = 'enrichedSection',
	/**
	 * Variant B. The same section, but files are grouped under collapsible
	 * location headers that show the absolute containing folder, so "where the
	 * files live" is the primary organizing principle.
	 */
	GroupedByLocation = 'groupedByLocation',
}

/** The presentation order the developer cycle command steps through. */
const PRESENTATION_ORDER: readonly ExternalChangesPresentation[] = [
	ExternalChangesPresentation.EnrichedSection,
	ExternalChangesPresentation.GroupedByLocation,
];

/**
 * Single source of truth for the active external-changes presentation. Every
 * consumer reads this observable so exactly one variant renders at a time and
 * the developer toggle switches instantly with no reload.
 */
export const externalChangesPresentationObs = observableValue<ExternalChangesPresentation>(
	'externalChangesPresentation',
	ExternalChangesPresentation.EnrichedSection,
);

/** Advance the active presentation to the next variant (wraps around). */
export function cycleExternalChangesPresentation(): ExternalChangesPresentation {
	const current = externalChangesPresentationObs.get();
	const index = PRESENTATION_ORDER.indexOf(current);
	const next = PRESENTATION_ORDER[(index + 1) % PRESENTATION_ORDER.length];
	externalChangesPresentationObs.set(next, undefined);
	return next;
}

/** Human-readable label for a presentation variant (used in the toggle toast). */
export function getExternalChangesPresentationLabel(presentation: ExternalChangesPresentation): string {
	switch (presentation) {
		case ExternalChangesPresentation.EnrichedSection:
			return localize('externalChanges.presentation.enrichedSection', "A: Enriched list");
		case ExternalChangesPresentation.GroupedByLocation:
			return localize('externalChanges.presentation.groupedByLocation', "B: Grouped by location");
	}
}
