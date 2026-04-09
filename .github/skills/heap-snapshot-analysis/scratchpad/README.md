# This folder is a scratchpad for heap snapshot investigation scripts.
# Files here are gitignored — write freely.
#
# Example usage:
#   node --max-old-space-size=16384 scratchpad/my-analysis.mjs
#
# Import helpers like:
#   import { parseSnapshot, buildGraph } from '../helpers/parseSnapshot.js';
#   import { compareSnapshots, printComparison } from '../helpers/compareSnapshots.js';
#   import { findRetainerPaths } from '../helpers/findRetainers.js';
