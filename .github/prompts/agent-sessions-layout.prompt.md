---
agent: agent
description: 'Work on Agent Sessions workbench layout'
---

# Agent Sessions Workbench Layout

When working on the Agent Sessions workbench layout, always refer to the specification document:

**Specification file**: `src/vs/workbench/agentSessions/LAYOUT.md`

## Guidelines

1. **Treat LAYOUT.md as the authoritative spec** - This document defines the fixed layout structure, supported operations, and implementation details for the Agent Sessions workbench.

2. **Read the spec first** - Before making any changes to the layout code, read and understand the current spec to ensure your changes align with the design.

3. **Update the spec when making changes** - If you modify the layout implementation, you MUST update LAYOUT.md to reflect those changes. The spec should always be in sync with the code.

When proposing changes, consider whether they align with the simplified, fixed nature of this layout.
