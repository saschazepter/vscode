/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';

/**
 * Sorts telemetry JSON files deterministically so that identical extractions
 * on different build agents produce byte-identical output.
 *
 * Usage: node sort-telemetry.ts <file1.json> [file2.json ...]
 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Recursively sorts all object keys. Arrays are left in place. */
function deepSortKeys(obj: JsonValue): JsonValue {
	if (Array.isArray(obj)) {
		return obj.map(deepSortKeys);
	}
	if (obj !== null && typeof obj === 'object') {
		const sorted: { [key: string]: JsonValue } = {};
		for (const key of Object.keys(obj).sort()) {
			sorted[key] = deepSortKeys(obj[key]);
		}
		return sorted;
	}
	return obj;
}

const files = process.argv.slice(2);

if (files.length === 0) {
	console.error('Usage: node sort-telemetry.ts <file1.json> [file2.json ...]');
	process.exit(1);
}

for (const file of files) {
	const raw = fs.readFileSync(file, 'utf-8');
	const data: JsonValue = JSON.parse(raw);
	const sorted = deepSortKeys(data);
	fs.writeFileSync(file, JSON.stringify(sorted, null, '\t') + '\n');
	console.log(`Sorted: ${file}`);
}
