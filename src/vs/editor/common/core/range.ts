/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IPosition, Position } from './position.js';

/**
 * A range in the editor. This interface is suitable for serialization.
 */
export interface IRange {
	/**
	 * The 1-based line number on which the range starts.
	 */
	readonly startLineNumber: number;
	/**
	 * The 1-based column on which the range starts in line `startLineNumber`.
	 */
	readonly startColumn: number;
	/**
	 * The 1-based line number on which the range ends.
	 */
	readonly endLineNumber: number;
	/**
	 * The 1-based column on which the range ends in line `endLineNumber`.
	 */
	readonly endColumn: number;
}

/**
 * A range in the editor.
 *
 * The start position `(startLineNumber, startColumn)` is always less than or
 * equal to the end position `(endLineNumber, endColumn)`. The constructor
 * normalizes its arguments, so the start is never after the end. Ranges are
 * immutable; methods that would change a range instead return a new
 * {@link Range}.
 */
export class Range {

	/**
	 * The 1-based line number on which the range starts.
	 */
	public readonly startLineNumber: number;
	/**
	 * The 1-based column on which the range starts in line `startLineNumber`.
	 */
	public readonly startColumn: number;
	/**
	 * The 1-based line number on which the range ends.
	 */
	public readonly endLineNumber: number;
	/**
	 * The 1-based column on which the range ends in line `endLineNumber`.
	 */
	public readonly endColumn: number;

	constructor(startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) {
		if ((startLineNumber > endLineNumber) || (startLineNumber === endLineNumber && startColumn > endColumn)) {
			this.startLineNumber = endLineNumber;
			this.startColumn = endColumn;
			this.endLineNumber = startLineNumber;
			this.endColumn = startColumn;
		} else {
			this.startLineNumber = startLineNumber;
			this.startColumn = startColumn;
			this.endLineNumber = endLineNumber;
			this.endColumn = endColumn;
		}
	}

	/**
	 * Test if this range is empty, i.e. its start position equals its end
	 * position.
	 */
	public isEmpty(): boolean {
		return Range.isEmpty(this);
	}

	/**
	 * Test if `range` is empty, i.e. its start position equals its end position.
	 */
	public static isEmpty(range: IRange): boolean {
		return (range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn);
	}

	/**
	 * Test if `position` is inside this range. A position on the start or end
	 * edge of the range is considered inside (returns true).
	 */
	public containsPosition(position: IPosition): boolean {
		return Range.containsPosition(this, position);
	}

	/**
	 * Test if `position` is inside `range`. A position on the start or end edge
	 * of the range is considered inside (returns true).
	 */
	public static containsPosition(range: IRange, position: IPosition): boolean {
		if (position.lineNumber < range.startLineNumber || position.lineNumber > range.endLineNumber) {
			return false;
		}
		if (position.lineNumber === range.startLineNumber && position.column < range.startColumn) {
			return false;
		}
		if (position.lineNumber === range.endLineNumber && position.column > range.endColumn) {
			return false;
		}
		return true;
	}

	/**
	 * Test if `position` is inside `range`. A position on the start or end edge
	 * of the range is considered outside (returns false).
	 * @internal
	 */
	public static strictContainsPosition(range: IRange, position: IPosition): boolean {
		if (position.lineNumber < range.startLineNumber || position.lineNumber > range.endLineNumber) {
			return false;
		}
		if (position.lineNumber === range.startLineNumber && position.column <= range.startColumn) {
			return false;
		}
		if (position.lineNumber === range.endLineNumber && position.column >= range.endColumn) {
			return false;
		}
		return true;
	}

	/**
	 * Test if `range` is fully contained within this range. A range equal to
	 * this range is considered contained (returns true).
	 */
	public containsRange(range: IRange): boolean {
		return Range.containsRange(this, range);
	}

	/**
	 * Test if `otherRange` is fully contained within `range`. Two equal ranges
	 * are considered contained (returns true).
	 */
	public static containsRange(range: IRange, otherRange: IRange): boolean {
		if (otherRange.startLineNumber < range.startLineNumber || otherRange.endLineNumber < range.startLineNumber) {
			return false;
		}
		if (otherRange.startLineNumber > range.endLineNumber || otherRange.endLineNumber > range.endLineNumber) {
			return false;
		}
		if (otherRange.startLineNumber === range.startLineNumber && otherRange.startColumn < range.startColumn) {
			return false;
		}
		if (otherRange.endLineNumber === range.endLineNumber && otherRange.endColumn > range.endColumn) {
			return false;
		}
		return true;
	}

	/**
	 * Test if `range` is strictly contained within this range. `range` must
	 * start strictly after and end strictly before this range for the result
	 * to be true; a range equal to this range returns false.
	 */
	public strictContainsRange(range: IRange): boolean {
		return Range.strictContainsRange(this, range);
	}

	/**
	 * Test if `otherRange` is strictly contained within `range`. `otherRange`
	 * must start strictly after and end strictly before `range`; two equal
	 * ranges return false.
	 */
	public static strictContainsRange(range: IRange, otherRange: IRange): boolean {
		if (otherRange.startLineNumber < range.startLineNumber || otherRange.endLineNumber < range.startLineNumber) {
			return false;
		}
		if (otherRange.startLineNumber > range.endLineNumber || otherRange.endLineNumber > range.endLineNumber) {
			return false;
		}
		if (otherRange.startLineNumber === range.startLineNumber && otherRange.startColumn <= range.startColumn) {
			return false;
		}
		if (otherRange.endLineNumber === range.endLineNumber && otherRange.endColumn >= range.endColumn) {
			return false;
		}
		return true;
	}

	/**
	 * Create the smallest range that contains both this range and `range`
	 * (their union). The smaller start position becomes the start, and the
	 * larger end position becomes the end.
	 */
	public plusRange(range: IRange): Range {
		return Range.plusRange(this, range);
	}

	/**
	 * Create the smallest range that contains both `a` and `b` (their union).
	 * The smaller start position becomes the start, and the larger end position
	 * becomes the end.
	 */
	public static plusRange(a: IRange, b: IRange): Range {
		let startLineNumber: number;
		let startColumn: number;
		let endLineNumber: number;
		let endColumn: number;

		if (b.startLineNumber < a.startLineNumber) {
			startLineNumber = b.startLineNumber;
			startColumn = b.startColumn;
		} else if (b.startLineNumber === a.startLineNumber) {
			startLineNumber = b.startLineNumber;
			startColumn = Math.min(b.startColumn, a.startColumn);
		} else {
			startLineNumber = a.startLineNumber;
			startColumn = a.startColumn;
		}

		if (b.endLineNumber > a.endLineNumber) {
			endLineNumber = b.endLineNumber;
			endColumn = b.endColumn;
		} else if (b.endLineNumber === a.endLineNumber) {
			endLineNumber = b.endLineNumber;
			endColumn = Math.max(b.endColumn, a.endColumn);
		} else {
			endLineNumber = a.endLineNumber;
			endColumn = a.endColumn;
		}

		return new Range(startLineNumber, startColumn, endLineNumber, endColumn);
	}

	/**
	 * Compute the intersection (overlapping part) of this range and `range`.
	 * Returns `null` if the two ranges do not overlap.
	 */
	public intersectRanges(range: IRange): Range | null {
		return Range.intersectRanges(this, range);
	}

	/**
	 * Compute the intersection (overlapping part) of ranges `a` and `b`.
	 * Returns `null` if the two ranges do not overlap.
	 */
	public static intersectRanges(a: IRange, b: IRange): Range | null {
		let resultStartLineNumber = a.startLineNumber;
		let resultStartColumn = a.startColumn;
		let resultEndLineNumber = a.endLineNumber;
		let resultEndColumn = a.endColumn;
		const otherStartLineNumber = b.startLineNumber;
		const otherStartColumn = b.startColumn;
		const otherEndLineNumber = b.endLineNumber;
		const otherEndColumn = b.endColumn;

		if (resultStartLineNumber < otherStartLineNumber) {
			resultStartLineNumber = otherStartLineNumber;
			resultStartColumn = otherStartColumn;
		} else if (resultStartLineNumber === otherStartLineNumber) {
			resultStartColumn = Math.max(resultStartColumn, otherStartColumn);
		}

		if (resultEndLineNumber > otherEndLineNumber) {
			resultEndLineNumber = otherEndLineNumber;
			resultEndColumn = otherEndColumn;
		} else if (resultEndLineNumber === otherEndLineNumber) {
			resultEndColumn = Math.min(resultEndColumn, otherEndColumn);
		}

		// Check if selection is now empty
		if (resultStartLineNumber > resultEndLineNumber) {
			return null;
		}
		if (resultStartLineNumber === resultEndLineNumber && resultStartColumn > resultEndColumn) {
			return null;
		}
		return new Range(resultStartLineNumber, resultStartColumn, resultEndLineNumber, resultEndColumn);
	}

	/**
	 * Test if this range equals `other`.
	 */
	public equalsRange(other: IRange | null | undefined): boolean {
		return Range.equalsRange(this, other);
	}

	/**
	 * Test if range `a` equals range `b`. Two nullish ranges (`null` or
	 * `undefined`) are considered equal.
	 */
	public static equalsRange(a: IRange | null | undefined, b: IRange | null | undefined): boolean {
		if (!a && !b) {
			return true;
		}
		return (
			!!a &&
			!!b &&
			a.startLineNumber === b.startLineNumber &&
			a.startColumn === b.startColumn &&
			a.endLineNumber === b.endLineNumber &&
			a.endColumn === b.endColumn
		);
	}

	/**
	 * Return the end position (which will be after or equal to the start position)
	 */
	public getEndPosition(): Position {
		return Range.getEndPosition(this);
	}

	/**
	 * Return the end position (which will be after or equal to the start position)
	 */
	public static getEndPosition(range: IRange): Position {
		return new Position(range.endLineNumber, range.endColumn);
	}

	/**
	 * Return the start position (which will be before or equal to the end position)
	 */
	public getStartPosition(): Position {
		return Range.getStartPosition(this);
	}

	/**
	 * Return the start position (which will be before or equal to the end position)
	 */
	public static getStartPosition(range: IRange): Position {
		return new Position(range.startLineNumber, range.startColumn);
	}

	/**
	 * Transform to a human-readable string of the form
	 * `[startLineNumber,startColumn -> endLineNumber,endColumn]`.
	 */
	public toString(): string {
		return '[' + this.startLineNumber + ',' + this.startColumn + ' -> ' + this.endLineNumber + ',' + this.endColumn + ']';
	}

	/**
	 * Create a new range using this range's start position, and using endLineNumber and endColumn as the end position.
	 */
	public setEndPosition(endLineNumber: number, endColumn: number): Range {
		return new Range(this.startLineNumber, this.startColumn, endLineNumber, endColumn);
	}

	/**
	 * Create a new range using this range's end position, and using startLineNumber and startColumn as the start position.
	 */
	public setStartPosition(startLineNumber: number, startColumn: number): Range {
		return new Range(startLineNumber, startColumn, this.endLineNumber, this.endColumn);
	}

	/**
	 * Create a new empty range using this range's start position.
	 */
	public collapseToStart(): Range {
		return Range.collapseToStart(this);
	}

	/**
	 * Create a new empty range using this range's start position.
	 */
	public static collapseToStart(range: IRange): Range {
		return new Range(range.startLineNumber, range.startColumn, range.startLineNumber, range.startColumn);
	}

	/**
	 * Create a new empty range using this range's end position.
	 */
	public collapseToEnd(): Range {
		return Range.collapseToEnd(this);
	}

	/**
	 * Create a new empty range using this range's end position.
	 */
	public static collapseToEnd(range: IRange): Range {
		return new Range(range.endLineNumber, range.endColumn, range.endLineNumber, range.endColumn);
	}

	/**
	 * Moves the range down by `lineCount` lines (or up when `lineCount` is
	 * negative), keeping its columns unchanged.
	 */
	public delta(lineCount: number): Range {
		return new Range(this.startLineNumber + lineCount, this.startColumn, this.endLineNumber + lineCount, this.endColumn);
	}

	/**
	 * Test if this range starts and ends on the same line.
	 */
	public isSingleLine(): boolean {
		return this.startLineNumber === this.endLineNumber;
	}

	// ---

	/**
	 * Create a `Range` spanning from `start` to `end`. When `end` is omitted,
	 * an empty range at `start` is created.
	 */
	public static fromPositions(start: IPosition, end: IPosition = start): Range {
		return new Range(start.lineNumber, start.column, end.lineNumber, end.column);
	}

	/**
	 * Create a `Range` from an `IRange`. Returns `null` when `range` is `null`
	 * or `undefined`.
	 */
	public static lift(range: undefined | null): null;
	public static lift(range: IRange): Range;
	public static lift(range: IRange | undefined | null): Range | null;
	public static lift(range: IRange | undefined | null): Range | null {
		if (!range) {
			return null;
		}
		return new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
	}

	/**
	 * Test if `obj` is an `IRange`, i.e. it has numeric `startLineNumber`,
	 * `startColumn`, `endLineNumber` and `endColumn` properties.
	 */
	public static isIRange(obj: unknown): obj is IRange {
		return (
			!!obj
			&& (typeof (obj as IRange).startLineNumber === 'number')
			&& (typeof (obj as IRange).startColumn === 'number')
			&& (typeof (obj as IRange).endLineNumber === 'number')
			&& (typeof (obj as IRange).endColumn === 'number')
		);
	}

	/**
	 * Test if ranges `a` and `b` intersect or merely touch (share an edge
	 * position without overlapping).
	 */
	public static areIntersectingOrTouching(a: IRange, b: IRange): boolean {
		// Check if `a` is before `b`
		if (a.endLineNumber < b.startLineNumber || (a.endLineNumber === b.startLineNumber && a.endColumn < b.startColumn)) {
			return false;
		}

		// Check if `b` is before `a`
		if (b.endLineNumber < a.startLineNumber || (b.endLineNumber === a.startLineNumber && b.endColumn < a.startColumn)) {
			return false;
		}

		// These ranges must intersect
		return true;
	}

	/**
	 * Test if ranges `a` and `b` overlap. Ranges that only touch at an edge
	 * (share a single position) are not considered intersecting.
	 */
	public static areIntersecting(a: IRange, b: IRange): boolean {
		// Check if `a` is before `b`
		if (a.endLineNumber < b.startLineNumber || (a.endLineNumber === b.startLineNumber && a.endColumn <= b.startColumn)) {
			return false;
		}

		// Check if `b` is before `a`
		if (b.endLineNumber < a.startLineNumber || (b.endLineNumber === a.startLineNumber && b.endColumn <= a.startColumn)) {
			return false;
		}

		// These ranges must intersect
		return true;
	}

	/**
	 * Test if ranges `a` and `b` overlap on more than a single line boundary,
	 * i.e. they are intersecting but not merely adjacent.
	 */
	public static areOnlyIntersecting(a: IRange, b: IRange): boolean {
		// Check if `a` is before `b`
		if (a.endLineNumber < (b.startLineNumber - 1) || (a.endLineNumber === b.startLineNumber && a.endColumn < (b.startColumn - 1))) {
			return false;
		}

		// Check if `b` is before `a`
		if (b.endLineNumber < (a.startLineNumber - 1) || (b.endLineNumber === a.startLineNumber && b.endColumn < (a.startColumn - 1))) {
			return false;
		}

		// These ranges must intersect
		return true;
	}

	/**
	 * A comparator function for ranges, useful for sorting. Compares first by
	 * start position and then by end position. Nullish ranges sort before
	 * non-nullish ones.
	 */
	public static compareRangesUsingStarts(a: IRange | null | undefined, b: IRange | null | undefined): number {
		if (a && b) {
			const aStartLineNumber = a.startLineNumber | 0;
			const bStartLineNumber = b.startLineNumber | 0;

			if (aStartLineNumber === bStartLineNumber) {
				const aStartColumn = a.startColumn | 0;
				const bStartColumn = b.startColumn | 0;

				if (aStartColumn === bStartColumn) {
					const aEndLineNumber = a.endLineNumber | 0;
					const bEndLineNumber = b.endLineNumber | 0;

					if (aEndLineNumber === bEndLineNumber) {
						const aEndColumn = a.endColumn | 0;
						const bEndColumn = b.endColumn | 0;
						return aEndColumn - bEndColumn;
					}
					return aEndLineNumber - bEndLineNumber;
				}
				return aStartColumn - bStartColumn;
			}
			return aStartLineNumber - bStartLineNumber;
		}
		const aExists = (a ? 1 : 0);
		const bExists = (b ? 1 : 0);
		return aExists - bExists;
	}

	/**
	 * A comparator function for ranges, useful for sorting. Compares first by
	 * end position and then by start position.
	 */
	public static compareRangesUsingEnds(a: IRange, b: IRange): number {
		if (a.endLineNumber === b.endLineNumber) {
			if (a.endColumn === b.endColumn) {
				if (a.startLineNumber === b.startLineNumber) {
					return a.startColumn - b.startColumn;
				}
				return a.startLineNumber - b.startLineNumber;
			}
			return a.endColumn - b.endColumn;
		}
		return a.endLineNumber - b.endLineNumber;
	}

	/**
	 * Test if `range` spans more than one line, i.e. its end line is after its
	 * start line.
	 */
	public static spansMultipleLines(range: IRange): boolean {
		return range.endLineNumber > range.startLineNumber;
	}

	/**
	 * Return a plain, serializable `IRange` representation of this range.
	 */
	public toJSON(): IRange {
		return this;
	}
}
