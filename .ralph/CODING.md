# Ralph Coding Session

You are in a Ralph loop - an autonomous coding session working through a PRD.

## Your Workflow

### 1. Get Your Bearings

```bash
pwd                           # Confirm working directory
cat ralph-progress.txt        # See what's been done
cat prd.json                  # See what needs to be done
git log --oneline -10         # Recent commits
```

### 2. Choose Your Task

From `prd.json`, pick the highest-priority item where `passes: false`.

**Priority order:**
1. `high` priority items first
2. Within same priority, prefer items that unblock others
3. Architectural/foundational work before features
4. Features before polish/cleanup

### 3. Implement the Feature

- **Small steps** - One logical change at a time
- **Follow patterns** - Match existing code style
- **Check AGENTS.md** - Follow project conventions

### 4. Run Feedback Loops

Before committing, ALL must pass:

```bash
make build          # Must compile
make fmt/check      # Must be formatted (run `make fmt` to fix)
make test/unit      # Tests must pass
```

**Do NOT commit if any feedback loop fails. Fix issues first.**

### 5. Update Progress

Append to `ralph-progress.txt`:
```
## [Timestamp] - [PRD Item Description]
- Completed: [what was done]
- Decisions: [any choices made and why]
- Files changed: [list of files]
- Notes: [anything for next iteration]
```

Keep entries **concise**. Sacrifice grammar for brevity.

### 6. Commit and Update PRD

```bash
git add -A
git commit -m "feat: [description of change]"
```

Update `prd.json` - set `passes: true` for the completed item.

Commit the PRD update:
```bash
git add prd.json ralph-progress.txt
git commit -m "chore: mark [item] as complete"
```

### 7. Check for Completion

If ALL items in `prd.json` have `passes: true`:
```
<promise>COMPLETE</promise>
```

Otherwise, continue to the next iteration.

---

## Project-Specific Guidelines

Use the `az` CLI tool to queue pipeline runs and view their status, as you make progress.

---

## Rules

### DO

✅ Work on ONE feature per iteration
✅ Run feedback loops after each change
✅ Commit working code only
✅ Update progress file with useful context
✅ Follow existing patterns in the codebase
✅ Keep changes small and focused

### DO NOT

❌ Skip feedback loops
❌ Commit broken code
❌ Remove or edit PRD items (only change `passes`)
❌ Work on multiple features at once
❌ Leave the codebase in a broken state
❌ Declare victory prematurely

---

## Recovering from Problems

### Build Fails
1. Read the error carefully
2. Fix the issue
3. Run `make build` again

### Tests Fail
1. Run the specific failing test to see details
2. Fix the issue
3. Run full test suite: `make test/unit`

### Formatting Fails
```bash
make fmt           # Auto-fix formatting
make fmt/check     # Verify it passes now
```

### Need to Revert
```bash
git log --oneline -5       # Find the good commit
git reset --hard <commit>  # Reset to it
```

---

## Completion Signal

When ALL PRD items pass, output exactly:

```
<promise>COMPLETE</promise>
```

This signals the loop to stop.
