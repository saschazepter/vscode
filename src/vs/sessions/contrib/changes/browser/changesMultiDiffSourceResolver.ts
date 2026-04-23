/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { derivedObservableWithCache, derivedOpts, ValueWithChangeEventFromObservable } from '../../../../base/common/observable.js';
import { equals as arraysEqual } from '../../../../base/common/arrays.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { comparePaths } from '../../../../base/common/comparers.js';
import { isIChatSessionFileChange2 } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { IMultiDiffSourceResolver, IMultiDiffSourceResolverService, IResolvedMultiDiffSource, MultiDiffEditorItem } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { ChangesViewPane } from './changesView.js';
import { CHANGES_VIEW_ID } from '../common/changes.js';
import { ISessionFileChange } from '../../../services/sessions/common/session.js';

const CHANGES_MULTI_DIFF_SOURCE_SCHEME = 'changes-multi-diff-source';

interface ChangesMultiDiffUriFields {
	readonly sessionResource: string;
}

/**
 * Build the multi-diff source URI for a session. The URI is used to identify
 * the multi-diff editor so subsequent opens with the same session reuse the
 * same input while the resource list updates reactively.
 */
export function getChangesMultiDiffSourceUri(sessionResource: URI): URI {
	return URI.from({
		scheme: CHANGES_MULTI_DIFF_SOURCE_SCHEME,
		query: JSON.stringify({ sessionResource: sessionResource.toString() } satisfies ChangesMultiDiffUriFields),
	});
}

function parseUri(uri: URI): { sessionResource: URI } | undefined {
	if (uri.scheme !== CHANGES_MULTI_DIFF_SOURCE_SCHEME) {
		return undefined;
	}

	let query: ChangesMultiDiffUriFields;
	try {
		query = JSON.parse(uri.query) as ChangesMultiDiffUriFields;
	} catch {
		return undefined;
	}

	if (typeof query !== 'object' || query === null || typeof query.sessionResource !== 'string') {
		return undefined;
	}

	return { sessionResource: URI.parse(query.sessionResource) };
}

function compareChanges(a: ISessionFileChange, b: ISessionFileChange): number {
	const aPath = isIChatSessionFileChange2(a) ? a.uri.fsPath : a.modifiedUri.fsPath;
	const bPath = isIChatSessionFileChange2(b) ? b.uri.fsPath : b.modifiedUri.fsPath;
	return comparePaths(aPath, bPath);
}

export class ChangesMultiDiffSourceResolver implements IMultiDiffSourceResolver {

	constructor(
		@IViewsService private readonly _viewsService: IViewsService,
	) { }

	canHandleUri(uri: URI): boolean {
		return parseUri(uri) !== undefined;
	}

	async resolveDiffSource(uri: URI): Promise<IResolvedMultiDiffSource> {
		const parsed = parseUri(uri)!;

		const changesObs = derivedObservableWithCache<readonly ISessionFileChange[]>({
			owner: this,
		}, (reader, lastValue) => {
			const view = this._viewsService.getViewWithId<ChangesViewPane>(CHANGES_VIEW_ID);
			if (!view) {
				return lastValue ?? [];
			}

			if (view.viewModel.activeSessionIsLoadingObs.read(reader)) {
				return lastValue ?? [];
			}

			const activeSessionResource = view.viewModel.activeSessionResourceObs.read(reader);
			if (!activeSessionResource || !isEqual(activeSessionResource, parsed.sessionResource)) {
				return lastValue ?? [];
			}

			return view.viewModel.activeSessionChangesObs.read(reader);
		});

		const resourcesObs = derivedOpts<readonly MultiDiffEditorItem[]>({
			owner: this,
			equalsFn: (a, b) => arraysEqual(a, b, (x, y) =>
				isEqual(x.originalUri, y.originalUri) &&
				isEqual(x.modifiedUri, y.modifiedUri)),
		}, reader => {
			const changes = changesObs.read(reader);
			return [...changes].sort(compareChanges).map(change =>
				new MultiDiffEditorItem(change.originalUri, change.modifiedUri, change.modifiedUri));
		});

		return { resources: new ValueWithChangeEventFromObservable(resourcesObs) };
	}
}

export class ChangesMultiDiffSourceResolverContribution extends Disposable {

	static readonly ID = 'workbench.contrib.changesMultiDiffSourceResolver';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IMultiDiffSourceResolverService multiDiffSourceResolverService: IMultiDiffSourceResolverService,
	) {
		super();

		this._register(multiDiffSourceResolverService.registerResolver(
			instantiationService.createInstance(ChangesMultiDiffSourceResolver)));
	}
}
