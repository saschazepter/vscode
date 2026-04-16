/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { assert, beforeEach, describe, it } from 'vitest';
import { ConfigKey } from '../../../../platform/configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../../../platform/configuration/common/defaultsOnlyConfigurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { InlineEditRequestLogContext } from '../../../../platform/inlineEdits/common/inlineEditLogContext';
import { MutableObservableWorkspace } from '../../../../platform/inlineEdits/common/observableWorkspace';
import { LogServiceImpl } from '../../../../platform/log/common/logService';
import { NullExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { URI } from '../../../../util/vs/base/common/uri';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import { StringEdit, StringReplacement } from '../../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { NextEditCache } from '../../node/nextEditCache';
import { NextEditFetchRequest } from '../../node/nextEditProvider';

/**
 * Regression test from a real scenario:
 *
 * User typed `class Fibonacci {\n\t` character by character. Two NES requests
 * were made at different points during typing:
 *
 * - Request #6 (early): doc ended with `class `, model predicted `class FibonacciCalculator {`
 * - Request #18 (later): doc ended with `class Fibonacci `, model predicted `class Fibonacci {`
 *
 * When `lookupNextEdit` runs, it should find and rebase the compatible cached edit
 * from request #18 (whose prediction matches the user's typing).
 */
describe('NextEditCache rebase — Fibonacci scenario', () => {

	let configService: InMemoryConfigurationService;
	let obsWorkspace: MutableObservableWorkspace;
	let logService: LogServiceImpl;
	let expService: NullExperimentationService;
	let cache: NextEditCache;
	let docId: DocumentId;

	// Common prefix of all document states — everything before the class declaration
	const docPrefix =
		'import * as vscode from \'vscode\';\n' +
		'import { ASTNodeWithOffset } from \'./nodeTypes\';\n' +
		'import { NodeTypesIndex } from \'./nodeTypesIndex\';\n' +
		'import { Result } from \'./util/common/result\';\n' +
		'import { LRUCache } from \'./util/vs/base/common/map\';\n' +
		'\n' +
		'export class NodeTypesDefinitionProvider implements vscode.DefinitionProvider {\n' +
		'\n' +
		'\tprivate _cache: LRUCache<ASTNodeWithOffset[], true>;\n' +
		'\tprivate _definitions: Map<string, ASTNodeWithOffset>;\n' +
		'\n' +
		'\tconstructor() {\n' +
		'\t\tthis._definitions = new Map();\n' +
		'\t\tthis._cache = new LRUCache<ASTNodeWithOffset[], true>(10);\n' +
		'\t}\n' +
		'\n' +
		'\tasync provideDefinition(\n' +
		'\t\tdocument: vscode.TextDocument,\n' +
		'\t\tposition: vscode.Position,\n' +
		'\t\ttoken: vscode.CancellationToken\n' +
		'\t): Promise<vscode.DefinitionLink[] | null> {\n' +
		'\t\tconst word = NodeTypesDefinitionProvider.positionToSymbol(document, position);\n' +
		'\t\tif (!word) {\n' +
		'\t\t\treturn null;\n' +
		'\t\t}\n' +
		'\t\tconst def = this.computeDefForSymbol(document, word);\n' +
		'\t\tif (!def) {\n' +
		'\t\t\treturn null;\n' +
		'\t\t}\n' +
		'\t\treturn [{\n' +
		'\t\t\ttargetUri: document.uri,\n' +
		'\t\t\ttargetRange: new vscode.Range(document.positionAt(def.offset), document.positionAt(def.offset + def.length))\n' +
		'\t\t}];\n' +
		'\t}\n' +
		'\n' +
		'\tprivate computeDefForSymbol(document: vscode.TextDocument, symbol: string) {\n' +
		'\t\tconst index = new NodeTypesIndex(document);\n' +
		'\t\tconst astNodes = index.nodes;\n' +
		'\t\tif (Result.isErr(astNodes)) {\n' +
		'\t\t\treturn null;\n' +
		'\t\t}\n' +
		'\t\tthis.recomputeDefinitions(astNodes.val);\n' +
		'\t\treturn this._definitions.get(symbol) || null;\n' +
		'\t}\n' +
		'\n' +
		'\tprivate recomputeDefinitions(nodes: ASTNodeWithOffset[]) {\n' +
		'\t\tif (this._cache.has(nodes)) {\n' +
		'\t\t\treturn;\n' +
		'\t\t}\n' +
		'\t\tfor (const node of nodes) {\n' +
		'\t\t\tthis._definitions.set(node.type.value, node);\n' +
		'\t\t}\n' +
		'\t\tthis._cache.set(nodes, true);\n' +
		'\t}\n' +
		'\n' +
		'\tprivate static positionToSymbol(document: vscode.TextDocument, position: vscode.Position) {\n' +
		'\t\tconst wordRange = document.getWordRangeAtPosition(position);\n' +
		'\t\treturn wordRange ? document.getText(wordRange) : null;\n' +
		'\t}\n' +
		'}\n' +
		'\n' +
		'function fibonacci(n: number): number {\n' +
		'\tif (n <= 1) {\n' +
		'\t\treturn n;\n' +
		'\t}\n' +
		'\treturn fibonacci(n - 1) + fibonacci(n - 2);\n' +
		'}\n' +
		'\n';

	// Document states at different points in time
	const docAtRequest18 = docPrefix + 'class Fibonacci ';     // offset 1944 → "class Fibonacci " ends at 1960
	const currentDoc = docPrefix + 'class Fibonacci {\n\t';    // offset 1944 → "class Fibonacci {\n\t" ends at 1963

	function makeSource(): NextEditFetchRequest {
		const logContext = new InlineEditRequestLogContext('test', 0, undefined);
		return new NextEditFetchRequest(generateUuid(), logContext, undefined, false);
	}

	beforeEach(() => {
		configService = new InMemoryConfigurationService(new DefaultsOnlyConfigurationService());
		configService.setConfig(ConfigKey.TeamInternal.InlineEditsReverseAgreement, true);
		obsWorkspace = new MutableObservableWorkspace();
		logService = new LogServiceImpl([]);
		expService = new NullExperimentationService();

		docId = DocumentId.create(URI.file('/Users/ulugbekna/code/tsq/src/nodeTypesDefinitionProvider.ts').toString());
		// Initialize workspace doc with the CURRENT document state
		// (so checkEditConsistency(documentBeforeEdit + userEditSince = currentDoc) passes)
		obsWorkspace.addDocument({ id: docId, initialValue: currentDoc });

		cache = new NextEditCache(obsWorkspace, logService, configService, expService);
	});

	it('rebases cached edit when model predicted class Fibonacci { and user typed the same', () => {
		// Scenario from real usage:
		//   documentBeforeEdit (at cache time): ...class Fibonacci \n (ends at offset 1960)
		//   Model's edit: replace [1944,1960) "class Fibonacci " → "class Fibonacci {"
		//   Model also has a 2nd edit: insert at 1961 → class body
		//   User then typed "{\n\t" → userEditSince: [1944,1960) → "class Fibonacci {\n\t"
		//
		// The user's typing is a superset of the model's first edit (model: "{", user: "{\n\t"),
		// so rebase should succeed and the 2nd edit (class body) should be offered.
		const cachedEdit = cache.setKthNextEdit(
			docId,
			new StringText(docAtRequest18),
			new OffsetRange(1944, 1960), // editWindow
			new StringReplacement(new OffsetRange(1944, 1960), 'class Fibonacci {'),
			0,
			[
				new StringReplacement(new OffsetRange(1944, 1960), 'class Fibonacci {'),
				new StringReplacement(OffsetRange.emptyAt(1961), '\n\tprivate memo: Map<number, number>;\n\n\tconstructor() {\n\t\tthis.memo = new Map();\n\t}\n\n\tcalc(n: number): number {\n\t\tif (n <= 1) {\n\t\t\treturn n;\n\t\t}\n\t\tif (this.memo.has(n)) {\n\t\t\treturn this.memo.get(n)!;\n\t\t}\n\t\tconst result = this.calc(n - 1) + this.calc(n - 2);\n\t\tthis.memo.set(n, result);\n\t\treturn result;\n\t}\n}'),
			],
			StringEdit.single(new StringReplacement(new OffsetRange(1944, 1960), 'class Fibonacci {\n\t')),
			makeSource(),
			{ isFromCursorJump: false, cursorOffset: 1960 },
		);

		assert(cachedEdit !== undefined, 'setKthNextEdit should return the cached edit');
		assert(cachedEdit.userEditSince !== undefined, 'userEditSince should be set');

		const rebaseResult = cache.tryRebaseCacheEntry(
			cachedEdit,
			new StringText(currentDoc),
			[new OffsetRange(1963, 1963)],
		);

		assert(rebaseResult.edit !== undefined, 'should rebase successfully');
		assert(rebaseResult.edit.rebasedEdit !== undefined, 'should have a rebased edit for the class body');
	});
});
