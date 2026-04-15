/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IssueReporterData } from '../common/issue.js';
import { localize } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ThemeIcon } from '../../../../base/common/themables.js';

const issueReporterIcon = registerIcon('issue-reporter', Codicon.report, localize('issueReporterIcon', 'Icon for the issue reporter editor.'));

export class IssueReporterEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.issueReporter';
	static readonly RESOURCE = URI.from({ scheme: 'vscode-issue-reporter', path: 'reporter' });

	private _data: IssueReporterData | undefined;

	constructor(data?: IssueReporterData) {
		super();
		this._data = data;
	}

	get data(): IssueReporterData | undefined {
		return this._data;
	}

	set data(value: IssueReporterData | undefined) {
		this._data = value;
	}

	override get typeId(): string {
		return IssueReporterEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	override get resource(): URI | undefined {
		return IssueReporterEditorInput.RESOURCE;
	}

	override getName(): string {
		return localize('issueReporter', "Report Issue");
	}

	override getIcon(): ThemeIcon | undefined {
		return issueReporterIcon;
	}

	override matches(other: EditorInput | unknown): boolean {
		return other instanceof IssueReporterEditorInput;
	}
}
