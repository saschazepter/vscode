/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { CheckboxActionViewItem } from '../../../../base/browser/ui/toggle/toggle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { Action2, MenuId, MenuItemAction, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { defaultCheckboxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IChangesViewService } from '../common/changesViewService.js';
import { SessionChangesFileResourceContext } from './changesMultiDiffSourceResolver.js';
import { ChangesetReviewedFilesContext, ChangesetReviewSupportContext } from './changesViewService.js';
import { SessionChangesEditor } from './sessionChangesEditor.js';

export const CHANGESET_REVIEW_ACTION_ID = 'changeset.review';

/**
 * Renders the per-file "Mark as Viewed" toggle in the Changes editor file header
 * as a checkbox with a static "Viewed" label (mirroring the GitHub pull request
 * "Viewed" checkbox), instead of the default icon-only toolbar button. The
 * command's toggling title ("Mark as Viewed" / "Mark as Not Viewed") is kept as
 * the accessible name so the action is announced, while the checkbox state
 * conveys the reviewed state.
 */
export class ChangesetReviewActionViewItem extends CheckboxActionViewItem {

	constructor(action: MenuItemAction, options: IActionViewItemOptions) {
		super(undefined, action, { ...options, label: true, checkboxStyles: { ...defaultCheckboxStyles, size: 14 } });
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('changeset-review-action');
	}

	override updateChecked(): void {
		super.updateChecked();

		// The tooltip depends on the checked state, but the base class only refreshes
		// the tooltip on label/tooltip changes (not on checked changes), so re-run it
		// here to keep the hover and aria-label in sync with the reviewed state.
		this.updateTooltip();
	}

	override getTooltip(): string {
		return this.action.checked
			? localize('changeset.viewed.tooltip', "Mark as Not Viewed")
			: localize('changeset.notViewed.tooltip', "Mark as Viewed");
	}
}

export class ChangesetReviewAction extends Action2 {
	constructor() {
		super({
			id: CHANGESET_REVIEW_ACTION_ID,
			title: localize('changeset.viewed', "Viewed"),
			f1: false,
			toggled: {
				condition: ContextKeyExpr.in(
					SessionChangesFileResourceContext.key,
					ChangesetReviewedFilesContext.key)
			},
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: ContextKeyExpr.and(
					ChangesetReviewSupportContext.isEqualTo(true),
					ContextKeyExpr.equals('resourceScheme', 'changes-multi-diff-source')
				),
				group: 'navigation',
				order: 100
			}
		});
	}

	override run(accessor: ServicesAccessor, ...args: unknown[]): void {
		const resource = args[0];
		if (!(resource instanceof URI)) {
			return;
		}

		const changesViewService = accessor.get(IChangesViewService);
		const activeEditorPane = accessor.get(IEditorService).activeEditorPane;

		const reviewedFiles = changesViewService.activeSessionChangesObs.get()
			.filter(change => change.reviewed)
			.map(change => change.modifiedUri?.toString() ?? change.originalUri?.toString())
			.filter((uri: string | undefined) => uri !== undefined);

		const review = !reviewedFiles.includes(resource.toString());

		// Toggle multi-file diff editor item
		if (activeEditorPane instanceof SessionChangesEditor) {
			if (review) {
				activeEditorPane.collapse(resource);
			} else {
				activeEditorPane.expand(resource);
			}
		}

		// Set the review state
		changesViewService.setChangesetFilesReviewState([resource], review);
	}
}

registerAction2(ChangesetReviewAction);
