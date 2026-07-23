/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import type { IAgentCreateSessionConfig } from './agentService.js';

/**
 * Shared helpers for the multi-root working-directory migration.
 *
 * A session's working directories are a set of **equal peers** (there is no
 * session-level primary); a chat may designate one of its directories as its
 * {@link https://github.com/microsoft/agent-host-protocol | primary}. These
 * helpers encapsulate the deterministic bridge between the (transitional)
 * singular `workingDirectory` on {@link IAgentCreateSessionConfig} and the
 * plural `workingDirectories` / `primaryWorkingDirectory` fields, so call sites
 * do not have to branch on which is present.
 */

/**
 * The requested working-directory set for a create-session config: the explicit
 * {@link IAgentCreateSessionConfig.workingDirectories}, or `undefined` when
 * absent (meaning "inherit / unspecified"). An empty array means "explicitly no
 * directories" and is preserved as-is.
 */
export function getConfigWorkingDirectories(config: IAgentCreateSessionConfig | undefined): readonly URI[] | undefined {
	return config?.workingDirectories;
}

/**
 * The single directory to use where a create-session config genuinely requires
 * one (e.g. the provider launch context / the default chat's primary root).
 *
 * Precedence: an explicit {@link IAgentCreateSessionConfig.primaryWorkingDirectory},
 * otherwise the first entry of the {@link getConfigWorkingDirectories | requested
 * set}. Returns `undefined` when the config requests no directories.
 */
export function getConfigPrimaryWorkingDirectory(config: IAgentCreateSessionConfig | undefined): URI | undefined {
	return config?.primaryWorkingDirectory ?? getConfigWorkingDirectories(config)?.[0];
}

/**
 * Derives the primary working directory from any object carrying the
 * multi-root fields (e.g. session/chat state or summary). Prefers an explicit
 * `primaryWorkingDirectory`, otherwise the first of `workingDirectories`.
 */
export function getPrimaryWorkingDirectory(state: { readonly primaryWorkingDirectory?: URI; readonly workingDirectories?: readonly URI[] } | undefined): URI | undefined {
	return state?.primaryWorkingDirectory ?? state?.workingDirectories?.[0];
}
