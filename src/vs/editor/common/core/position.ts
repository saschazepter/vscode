/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A position in the editor. This interface is suitable for serialization.
 */
exportinterface IPosition {
	/**
	 * The 1-based line number. The first line is line 1.
	 */
	readonly lineNumber: number;
	/**
	 * The 1-based column number. A column points at the gap between two
	 * characters: column 1 is before the first character of the line, column 2
	 * is between the first and second character, and so on.
	 */
	readonly column: number;
}

/**
 * A position in the editor.
 *
 * Positions are immutable. Methods that would change a position instead return
 * a new {@link Position}.
 */
export class Position {
	/**
	 * The 1-based line number. The first line is line 1.
	 */
	public readonly lineNumber: number;
	/**
	 * The 1-based column number. A column points at the gap between two
	 * characters: column 1 is before the first character of the line, column 2
	 * is between the first and second character, and so on.
	 */
	public readonly column: number;

	constructor(lineNumber: number, column: number) {
		this.lineNumber = lineNumber;
		this.column = column;
	}

	/**
	 * Create a new position derived from this one, overriding the line number
	 * and/or column. Arguments that are left out default to this position's
	 * values. Returns `this` if nothing changed.
	 *
	 * @param newLineNumber the new line number (defaults to this line number)
	 * @param newColumn the new column (defaults to this column)
	 */
	with(newLineNumber: number = this.lineNumber, newColumn: number = this.column): Position {
		if (newLineNumber === this.lineNumber && newColumn === this.column) {
			return this;
		} else {
			return new Position(newLineNumber, newColumn);
		}
	}

	/**
	 * Create a new position by moving this position by the given deltas. The
	 * resulting line number and column are each clamped to a minimum of 1.
	 *
	 * @param deltaLineNumber the number of lines to move by (defaults to 0)
	 * @param deltaColumn the number of columns to move by (defaults to 0)
	 */
	delta(deltaLineNumber: number = 0, deltaColumn: number = 0): Position {
		return this.with(Math.max(1, this.lineNumber + deltaLineNumber), Math.max(1, this.column + deltaColumn));
	}

	/**
	 * Test if this position equals `other`.
	 */
	public equals(other: IPosition): boolean {
		return Position.equals(this, other);
	}

	/**
	 * Test if position `a` equals position `b`. Two `null` positions are
	 * considered equal.
	 */
	public static equals(a: IPosition | null, b: IPosition | null): boolean {
		if (!a && !b) {
			return true;
		}
		return (
			!!a &&
			!!b &&
			a.lineNumber === b.lineNumber &&
			a.column === b.column
		);
	}

	/**
	 * Test if this position is before other position.
	 * If the two positions are equal, the result will be false.
	 */
	public isBefore(other: IPosition): boolean {
		return Position.isBefore(this, other);
	}

	/**
	 * Test if position `a` is before position `b`.
	 * If the two positions are equal, the result will be false.
	 */
	public static isBefore(a: IPosition, b: IPosition): boolean {
		if (a.lineNumber < b.lineNumber) {
			return true;
		}
		if (b.lineNumber < a.lineNumber) {
			return false;
		}
		return a.column < b.column;
	}

	/**
	 * Test if this position is before other position.
	 * If the two positions are equal, the result will be true.
	 */
	public isBeforeOrEqual(other: IPosition): boolean {
		return Position.isBeforeOrEqual(this, other);
	}

	/**
	 * Test if position `a` is before position `b`.
	 * If the two positions are equal, the result will be true.
	 */
	public static isBeforeOrEqual(a: IPosition, b: IPosition): boolean {
		if (a.lineNumber < b.lineNumber) {
			return true;
		}
		if (b.lineNumber < a.lineNumber) {
			return false;
		}
		return a.column <= b.column;
	}

	/**
	 * A comparator function for positions, useful for sorting. Returns a
	 * negative number if `a` comes before `b`, a positive number if `a` comes
	 * after `b`, and 0 if they are at the same position.
	 */
	public static compare(a: IPosition, b: IPosition): number {
		const aLineNumber = a.lineNumber | 0;
		const bLineNumber = b.lineNumber | 0;

		if (aLineNumber === bLineNumber) {
			const aColumn = a.column | 0;
			const bColumn = b.column | 0;
			return aColumn - bColumn;
		}

		return aLineNumber - bLineNumber;
	}

	/**
	 * Clone this position.
	 */
	public clone(): Position {
		return new Position(this.lineNumber, this.column);
	}

	/**
	 * Convert to a human-readable representation of the form `(lineNumber,column)`.
	 */
	public toString(): string {
		return '(' + this.lineNumber + ',' + this.column + ')';
	}

	// ---

	/**
	 * Create a `Position` from an `IPosition`. Unlike {@link Position.clone},
	 * this accepts any object that satisfies the `IPosition` interface.
	 */
	public static lift(pos: IPosition): Position {
		return new Position(pos.lineNumber, pos.column);
	}

	/**
	 * Test if `obj` is an `IPosition`, i.e. it has numeric `lineNumber` and
	 * `column` properties.
	 */
	public static isIPosition(obj: unknown): obj is IPosition {
		return (
			!!obj
			&& (typeof (obj as IPosition).lineNumber === 'number')
			&& (typeof (obj as IPosition).column === 'number')
		);
	}

	/**
	 * Return a plain, serializable `IPosition` representation of this position.
	 */
	public toJSON(): IPosition {
		return {
			lineNumber: this.lineNumber,
			column: this.column
		};
	}
}
