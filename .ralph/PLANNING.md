# Ralph Planning Session

This document guides PRD (Product Requirements Document) creation for a Ralph loop.

## How to Use

Reference this file when starting a planning session:
```
@.ralph/PLANNING.md

I want to build [describe your feature]
```

---

## Planning Process

### Step 1: Understand the Feature

I'll ask clarifying questions about:
- What problem are we solving?
- Who is the user?
- What does "done" look like?
- What are the constraints?
- What existing code/patterns should we follow?

### Step 2: Explore the Codebase

I'll investigate:
- Relevant existing code and patterns
- Similar implementations to reference
- Test patterns and conventions
- Any potential conflicts or dependencies

### Step 3: Break Down into PRD Items

Each PRD item will have:
- **category**: `functional`, `technical`, `testing`, `cleanup`
- **description**: What needs to be done
- **steps**: How to verify it's complete
- **priority**: `high`, `medium`, `low`
- **passes**: Always starts as `false`

### Step 4: Output prd.json

I'll create a structured JSON file with all requirements.

---

## PRD Item Guidelines

### Good PRD Items

✅ **Small and focused** - One logical change
✅ **Verifiable** - Clear steps to confirm completion
✅ **Independent** - Can be completed in isolation (mostly)
✅ **Explicit** - No ambiguity about what "done" means

### Bad PRD Items

❌ "Implement the feature" - Too vague
❌ "Fix everything" - No clear scope
❌ "Make it better" - Subjective
❌ Items that require 1000+ lines of code changes

### Priority Guidelines

| Priority | When to Use |
|----------|-------------|
| `high` | Architectural decisions, core abstractions, integration points |
| `medium` | Standard feature implementation |
| `low` | Polish, cleanup, nice-to-haves |

### Category Guidelines

| Category | Examples |
|----------|----------|
| `functional` | User-facing features, API endpoints, UI components |
| `technical` | Refactoring, infrastructure, internal improvements |
| `testing` | Unit tests, integration tests, test coverage |
| `cleanup` | Code formatting, documentation, removing dead code |

---

## Example PRD Items

```json
{
  "items": [
    {
      "category": "technical",
      "description": "Create the DAL interface and implementation for the new entity",
      "steps": [
        "Create IEntityDal interface in the appropriate namespace",
        "Implement EntityDal with CosmosDB operations",
        "Add auditing with IAccessLogWriter",
        "Register in DI container"
      ],
      "priority": "high",
      "passes": false
    },
    {
      "category": "functional",
      "description": "Add GET endpoint to retrieve entity by ID",
      "steps": [
        "Add controller action with proper authorization",
        "Implement service method",
        "Verify endpoint returns correct data",
        "Swagger documentation is accurate"
      ],
      "priority": "medium",
      "passes": false
    },
    {
      "category": "testing",
      "description": "Add unit tests for the service layer",
      "steps": [
        "Create test class following project conventions",
        "Test happy path scenarios",
        "Test error cases and edge cases",
        "All tests pass with `make test/unit`"
      ],
      "priority": "medium",
      "passes": false
    }
  ]
}
```

---

## Quality Expectations

From the project's AGENTS.md, remember:

- **Production code** - Must be maintainable, follow existing patterns
- **Nullable reference types** - Handle nullability properly
- **Primary constructors** - Use for dependency injection
- **Auditing required** - All member data operations must be audited
- **Tests required** - Follow MSTest conventions (Arrange, Act, Assert)
- **Format before commit** - Run `make fmt`

---

## Output

When planning is complete, I'll create:

1. **`prd.json`** - The structured requirements file
2. **Summary** - Overview of what we're building and key decisions

You can then run:
```bash
./.ralph/init.sh
./.ralph/ralph.sh once  # Start with HITL mode
```

---

## Questions I'll Ask

1. Can you describe the feature in more detail?
2. Are there similar patterns in the codebase I should follow?
3. What's the scope - should this be a small focused change or larger refactor?
4. Are there any constraints I should know about?
5. How should we handle [specific edge case]?
6. What testing approach makes sense here?

Let's begin! Describe what you want to build.
