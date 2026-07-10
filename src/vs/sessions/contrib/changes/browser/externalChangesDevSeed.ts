/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ISessionFile, SessionFileOperation } from '../../../services/sessions/common/session.js';

/**
 * Developer-only override that seeds the "Changes Outside This Workspace"
 * section with representative sample files. Out-of-workspace changes are
 * normally produced by a real agent run, which is not reproducible on demand;
 * this seed lets us demo and compare the presentation variants deterministically.
 *
 * When set to a non-undefined value, {@link SessionFilesViewModel} uses it in
 * place of the active session's real external changes. Toggle it with the
 * developer command `Developer: Toggle Sample Agent External Changes (Dev)`.
 */
export const externalChangesDevSeedObs = observableValue<readonly ISessionFile[] | undefined>(
	'externalChangesDevSeed',
	undefined,
);

/** Representative out-of-workspace files across a few distinct locations. */
export const SAMPLE_EXTERNAL_CHANGES: readonly ISessionFile[] = Object.freeze([
	{ uri: URI.file('/Users/you/Desktop/agent-notes/architecture-plan.md'), operation: SessionFileOperation.Created },
	{ uri: URI.file('/Users/you/Desktop/agent-notes/api-reference.md'), operation: SessionFileOperation.Created },
	{ uri: URI.file('/Users/you/.config/agent-scratch/settings.json'), operation: SessionFileOperation.Modified },
	{ uri: URI.file('/tmp/agent-scratch/scratch.py'), operation: SessionFileOperation.Created },
	{ uri: URI.file('/tmp/agent-scratch/old-notes.txt'), operation: SessionFileOperation.Deleted },
]);

/** Flip the dev seed on/off. Returns whether it is now on. */
export function toggleExternalChangesDevSeed(): boolean {
	const on = externalChangesDevSeedObs.get() !== undefined;
	externalChangesDevSeedObs.set(on ? undefined : SAMPLE_EXTERNAL_CHANGES, undefined);
	return !on;
}
