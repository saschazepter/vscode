/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	export interface HoverOptions {
		canIncreaseVerbosity?: boolean;
		canDecreaseVerbosity?: boolean;
	}

	/**
	 * A hover represents additional information for a symbol or word. Hovers are
	 * rendered in a tooltip-like widget.
	 */
	export class Hover2 extends Hover {

		options?: HoverOptions;

		/**
		 * Creates a new hover object.
		 *
		 * @param contents The contents of the hover.
		 * @param range The range to which the hover applies.
		 */
		constructor(contents: MarkdownString | MarkedString | Array<MarkdownString | MarkedString>, range?: Range, options?: HoverOptions);
	}

	export interface HoverContext {

		// We think this should be required, but to prevent breaking changes, we're making it optional for now.
		// undefined for initially show, +/- this gets set
		readonly verbosityDepth?: number; // defaults to 0

	}

	/**
	 * The hover provider class
	 */
	export interface HoverProvider {

		/**
		 * Provide a hover for the given position and document. Multiple hovers at the same
		 * position will be merged by the editor. A hover can have a range which defaults
		 * to the word range at the position when omitted.
		 *
		 * @param document The document in which the command was invoked.
		 * @param position The position at which the command was invoked.
		 * @param token A cancellation token.
		 * @oaram context A hover context.
		 * @returns A hover or a thenable that resolves to such. The lack of a result can be
		 * signaled by returning `undefined` or `null`.
		 */
		provideHover(document: TextDocument, position: Position, token: CancellationToken, context?: HoverContext): ProviderResult<VerboseHover>;
	}
}
