/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Retainer Path Analysis
 *
 * Finds what keeps objects alive in the heap by tracing non-weak
 * reverse edges from target objects to GC roots.
 */

import { type HeapGraph, type HeapNode } from './parseSnapshot.js';

export interface RetainerPathOptions {
	/** Maximum number of paths to find per target class. Default: 5. */
	maxPaths?: number;
	/** Maximum BFS depth. Default: 25. */
	maxDepth?: number;
}

/**
 * Find retainer paths for all instances of a named class.
 * Skips weak edges so only genuine retainers are reported.
 *
 * @returns The number of paths found.
 */
export function findRetainerPaths(
	graph: HeapGraph,
	targetName: string,
	options: RetainerPathOptions = {},
): number {
	const { maxPaths = 5, maxDepth = 25 } = options;

	// Find target nodes
	const targets: number[] = [];
	for (let i = 0; i < graph.nodes.length; i++) {
		if (graph.nodes[i].name === targetName && graph.nodes[i].type === 'object') {
			targets.push(i);
		}
	}

	console.log(`Found ${targets.length} instances of ${targetName}`);

	let pathsFound = 0;
	for (const targetIdx of targets) {
		if (pathsFound >= maxPaths) { break; }

		const path = bfsToRoot(graph, targetIdx, maxDepth);
		if (path) {
			console.log(`\nPath #${pathsFound + 1} for ${targetName} (id:${graph.nodes[targetIdx].id}):`);
			printPath(graph, path);
			pathsFound++;
		} else {
			console.log(`\n[No path found for ${targetName} (id:${graph.nodes[targetIdx].id})]`);
		}
	}

	return pathsFound;
}

/**
 * Find ALL non-weak retainers of a specific node (by node index).
 * Returns the immediate parent nodes that reference this node.
 */
export function findDirectRetainers(
	graph: HeapGraph,
	nodeIndex: number,
): { node: HeapNode; edgeName: string; edgeType: string }[] {
	const incoming = graph.reverseEdges.get(nodeIndex) || [];
	return incoming.map(edge => ({
		node: graph.nodes[edge.fromNodeIndex],
		edgeName: edge.edgeName,
		edgeType: edge.edgeType,
	}));
}

/**
 * Find a node by its heap ID and optional name filter.
 */
export function findNodeById(graph: HeapGraph, id: number, name?: string): number {
	for (let i = 0; i < graph.nodes.length; i++) {
		if (graph.nodes[i].id === id && (!name || graph.nodes[i].name === name)) {
			return i;
		}
	}
	return -1;
}

/**
 * Find all instances of a named class.
 */
export function findNodesByName(graph: HeapGraph, name: string, type = 'object'): HeapNode[] {
	return graph.nodes.filter(n => n.name === name && n.type === type);
}

// ---- Internal ----

function bfsToRoot(graph: HeapGraph, startNi: number, maxDepth: number): number[] | null {
	const visited = new Set<number>();
	const queue: number[][] = [[startNi]];
	visited.add(startNi);

	while (queue.length > 0) {
		const path = queue.shift()!;
		const current = path[path.length - 1];

		if (path.length > maxDepth) { continue; }

		const node = graph.nodes[current];
		if (node.type === 'synthetic' || current === 0) {
			return path;
		}

		const incoming = graph.reverseEdges.get(current) || [];
		for (const edge of incoming) {
			if (!visited.has(edge.fromNodeIndex)) {
				visited.add(edge.fromNodeIndex);
				queue.push([...path, edge.fromNodeIndex]);
			}
		}
	}

	return null;
}

function printPath(graph: HeapGraph, path: number[]): void {
	for (let idx = 0; idx < path.length; idx++) {
		const n = graph.nodes[path[idx]];
		let edgeLabel = '';
		if (idx > 0) {
			const prevNi = path[idx - 1];
			const edges = graph.reverseEdges.get(prevNi) || [];
			const edge = edges.find(e => e.fromNodeIndex === path[idx]);
			edgeLabel = edge ? ` <--[${edge.edgeName}(${edge.edgeType})]-- ` : ' <-- ';
		}
		console.log(`  ${edgeLabel}${n.type}::${n.name}(${n.id})`);
	}
}
