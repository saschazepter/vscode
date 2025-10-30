/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Range } from '../../../common/core/range.js';
import { LanguageIdCodec } from '../../../common/services/languagesRegistry.js';
import { SparseMultilineTokens } from '../../../common/tokens/sparseMultilineTokens.js';
import { SparseTokensStore } from '../../../common/tokens/sparseTokensStore.js';

suite('SparseTokensStore', () => {
	const languageIdCodec = new LanguageIdCodec();

	test('piece with startLineNumber -1 and endLineNumber 0 after token removal', () => {
		// Create a piece starting at line 0 with tokens
		// The encoding format is: [deltaLine, startChar, endChar, metadata] for each token
		// Creating a token at line 0, characters 0-5
		const tokens = new Uint32Array([
			0,  // deltaLine (relative to startLineNumber)
			0,  // startCharacter
			5,  // endCharacter
			5   // metadata (some color)
		]);
		const piece = SparseMultilineTokens.create(0, tokens);

		// Verify initial state
		assert.strictEqual(piece.startLineNumber, 0);
		assert.strictEqual(piece.endLineNumber, 0);

		const store = new SparseTokensStore(languageIdCodec);
		store.set([piece], false);

		// Now remove all tokens by calling removeTokens with a range that covers everything
		// This should remove all tokens, leaving an empty piece
		const removalRange = new Range(0, 1, 0, 100);
		store.setPartial(removalRange, []);

		// The piece should be removed from the store since it's empty
		// But if it's not properly removed, or if there's a bug in how empty pieces are handled,
		// we might end up with a piece that has invalid line numbers
		const pieces = (store as any)._pieces as SparseMultilineTokens[];

		// Check if any piece has invalid line numbers
		for (const p of pieces) {
			console.log(`Piece: startLineNumber=${p.startLineNumber}, endLineNumber=${p.endLineNumber}`);
			assert.notStrictEqual(p.startLineNumber, -1, 'Piece should not have startLineNumber -1');
			assert.notStrictEqual(p.endLineNumber, 0, 'Piece should not have endLineNumber 0 when startLineNumber is -1');
		}
	});

	test('piece with startLineNumber -1 and endLineNumber 0 after split operation', () => {
		// Create a piece starting at line 0 with tokens
		const tokens = new Uint32Array([
			0,  // deltaLine
			0,  // startCharacter
			5,  // endCharacter
			5   // metadata
		]);
		const piece = SparseMultilineTokens.create(0, tokens);

		const store = new SparseTokensStore(languageIdCodec);
		store.set([piece], false);

		// Split the piece by removing tokens in the middle
		// This should cause the piece to be split into two pieces
		const splitRange = new Range(0, 1, 0, 5);
		store.setPartial(splitRange, []);

		// Check pieces after split
		const pieces = (store as any)._pieces as SparseMultilineTokens[];
		for (const p of pieces) {
			console.log(`Piece after split: startLineNumber=${p.startLineNumber}, endLineNumber=${p.endLineNumber}, isEmpty=${p.isEmpty()}`);
			if (!p.isEmpty()) {
				assert.ok(p.startLineNumber >= 0, `Piece startLineNumber should be >= 0, got ${p.startLineNumber}`);
				assert.ok(p.endLineNumber >= p.startLineNumber, `Piece endLineNumber should be >= startLineNumber, got startLineNumber=${p.startLineNumber}, endLineNumber=${p.endLineNumber}`);
			}
		}
	});

	test('piece with startLineNumber -1 and endLineNumber 0 when deletion occurs before block', () => {
		// Create a piece starting at line 1 with tokens
		const tokens = new Uint32Array([
			0,  // deltaLine (relative to startLineNumber=1, so this is line 1)
			0,  // startCharacter
			5,  // endCharacter
			5   // metadata
		]);
		const piece = SparseMultilineTokens.create(1, tokens);

		const store = new SparseTokensStore(languageIdCodec);
		store.set([piece], false);

		// Accept a deletion that occurs before the piece (line 0)
		// This should adjust the piece's startLineNumber
		const deletionRange = new Range(1, 1, 1, 1); // No-op deletion
		store.acceptEdit(deletionRange, 0, 0, 0, 0);

		// Now remove all tokens
		const removalRange = new Range(1, 1, 1, 100);
		store.setPartial(removalRange, []);

		const pieces = (store as any)._pieces as SparseMultilineTokens[];
		for (const p of pieces) {
			console.log(`Piece after deletion and removal: startLineNumber=${p.startLineNumber}, endLineNumber=${p.endLineNumber}, isEmpty=${p.isEmpty()}`);
			if (!p.isEmpty()) {
				assert.ok(p.startLineNumber >= 0, `Piece startLineNumber should be >= 0, got ${p.startLineNumber}`);
				assert.ok(p.endLineNumber >= p.startLineNumber, `Piece endLineNumber should be >= startLineNumber`);
			}
		}
	});

	test('reproduce startLineNumber -1 and endLineNumber 0 bug', () => {
		// Bug: A piece ends up with startLineNumber = -1 and endLineNumber = 0
		// This occurs when:
		// 1. Piece starts at line 0 with a token at deltaLine 1
		// 2. removeTokens is called with a range that starts before the piece (startLineIndex < 0)
		// 3. All tokens are removed, but startLineNumber adjustment is incorrect
		// 4. Then _acceptDeleteRange or _updateEndLineNumber results in startLineNumber = -1 and endLineNumber = 0
		
		// The key scenario: When removeTokens is called with startLineIndex < 0,
		// if all tokens are removed, firstDeltaLine stays 0 (initial value).
		// startLineNumber += 0, stays 0.
		// But if _acceptDeleteRange was called and adjusted startLineNumber to -1,
		// then _updateEndLineNumber calculates endLineNumber = -1 + getMaxDeltaLine().
		// If the piece is empty, getMaxDeltaLine() = -1, so endLineNumber = -2, not 0.
		// But if there's still a token at deltaLine 1, getMaxDeltaLine() = 1, so endLineNumber = 0.
		
		// So the bug scenario is: piece has startLineNumber = -1 and a token at deltaLine 1
		// This happens when _acceptDeleteRange adjusts startLineNumber incorrectly.
		
		// Create piece at line 0 with token at deltaLine 1
		const piece = SparseMultilineTokens.create(0, new Uint32Array([1, 0, 10, 5]));
		
		// Verify initial state  
		assert.strictEqual(piece.startLineNumber, 0);
		assert.strictEqual(piece.endLineNumber, 1);
		
		// The bug occurs when acceptEdit is called with a deletion range that causes
		// _acceptDeleteRange to adjust startLineNumber incorrectly to -1.
		// Then _updateEndLineNumber calculates endLineNumber = -1 + 1 = 0.
		
		// Try to trigger the bug by calling acceptEdit with various ranges
		piece.acceptEdit(new Range(0, 1, 0, 1), 0, 0, 0, 0);
		
		// Also test removeTokens directly
		const piece2 = SparseMultilineTokens.create(0, new Uint32Array([1, 0, 10, 5]));
		piece2.removeTokens(new Range(0, 1, 1, 100)); // Remove all tokens
		
		// Check for the bug condition
		const pieces = [piece, piece2];
		for (const p of pieces) {
			if (!p.isEmpty()) {
				// The bug: startLineNumber = -1 and endLineNumber = 0
				if (p.startLineNumber === -1 && p.endLineNumber === 0) {
					assert.fail(`Bug reproduced! Piece has startLineNumber -1 and endLineNumber 0`);
				}
				// Also check for invalid state where endLineNumber < startLineNumber
				if (p.endLineNumber < p.startLineNumber) {
					assert.fail(`Invalid piece state: endLineNumber (${p.endLineNumber}) < startLineNumber (${p.startLineNumber})`);
				}
			}
		}
	});
});

