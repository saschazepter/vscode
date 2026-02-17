#!/bin/bash
# Ralph Loop Controller
# Usage: ./ralph.sh <iterations|once>
#
# Examples:
#   ./ralph.sh once    # Run one iteration (HITL mode)
#   ./ralph.sh 5       # Run 5 iterations (AFK mode)
#   ./ralph.sh 10      # Run 10 iterations

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Parse arguments
if [ -z "$1" ]; then
    echo "Ralph Loop Controller"
    echo ""
    echo "Usage: $0 <iterations|once>"
    echo ""
    echo "  once    Run a single iteration (HITL mode - watch and intervene)"
    echo "  N       Run N iterations (AFK mode - autonomous)"
    echo ""
    echo "Examples:"
    echo "  $0 once   # Human-in-the-loop mode"
    echo "  $0 5      # Run 5 iterations"
    echo "  $0 10     # Run 10 iterations"
    echo ""
    exit 1
fi

if [ "$1" = "once" ]; then
    ITERATIONS=1
    MODE="HITL"
else
    ITERATIONS=$1
    MODE="AFK"
fi

# Validate iterations is a number
if ! [[ "$ITERATIONS" =~ ^[0-9]+$ ]]; then
    echo "Error: iterations must be a number or 'once'"
    exit 1
fi

# Check prerequisites
if [ ! -f "prd.json" ]; then
    echo "❌ Error: prd.json not found"
    echo "   Run a planning session first with @.ralph/PLANNING.md"
    exit 1
fi

if [ ! -f "ralph-progress.txt" ]; then
    echo "❌ Error: ralph-progress.txt not found"
    echo "   Run ./.ralph/init.sh first"
    exit 1
fi

# Count PRD status
TOTAL_ITEMS=$(grep -c '"passes"' prd.json 2>/dev/null || true)
PASSING_ITEMS=$(grep -c '"passes": true' prd.json 2>/dev/null || true)
REMAINING=$((TOTAL_ITEMS - PASSING_ITEMS))

echo "🔄 Starting Ralph Loop"
echo "   Mode: $MODE"
echo "   Iterations: $ITERATIONS"
echo "   PRD items remaining: $REMAINING / $TOTAL_ITEMS"
echo ""

if [ "$REMAINING" -eq 0 ]; then
    echo "✅ All PRD items already complete!"
    exit 0
fi

# Build the prompt
PROMPT="@.ralph/CODING.md @prd.json @ralph-progress.txt @AGENTS.md

You are in iteration of a Ralph loop.

## Your Task

1. Read ralph-progress.txt to see what's been done
2. Read prd.json and choose the highest-priority item where passes=false
3. Implement that ONE feature
4. Run feedback loops: make build && make fmt/check && make test/unit
5. Update ralph-progress.txt with your progress
6. Commit your changes with a descriptive message
7. Update prd.json to mark the item as passes=true
8. Commit the progress update

## Rules

- Work on ONE feature only
- Do NOT commit if feedback loops fail
- Do NOT remove or edit PRD items (only change passes field)
- Keep changes small and focused
- Follow existing patterns in the codebase

## Completion

If ALL items in prd.json have passes=true, output exactly:
<promise>COMPLETE</promise>

Otherwise, complete your one feature and stop.
"

# Run the loop
for ((i=1; i<=$ITERATIONS; i++)); do
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📍 Iteration $i of $ITERATIONS"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # Run Claude Code (or your preferred AI coding CLI)
    # Uncomment the appropriate line for your setup:

    # Option 1: Claude Code CLI
    # result=$(claude -p "$PROMPT" 2>&1)

    # Option 2: Claude Code in Docker sandbox (safer for AFK)
    # result=$(docker sandbox run claude -p "$PROMPT" 2>&1)

    # Option 3: GitHub Copilot CLI
    # result=$(gh copilot suggest "$PROMPT" 2>&1)

    result=$(copilot -p "$PROMPT")

    # For now, we'll just print instructions since this runs in VS Code
    echo "📋 Run this prompt in your AI coding assistant:"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$PROMPT"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # In interactive mode, wait for user
    if [ "$MODE" = "HITL" ]; then
        echo "Press Enter when the iteration is complete..."
        read -r
    fi

    # Check for completion
    PASSING_ITEMS=$(grep -c '"passes": true' prd.json 2>/dev/null || true)
    REMAINING=$((TOTAL_ITEMS - PASSING_ITEMS))

    echo ""
    echo "📊 Progress: $PASSING_ITEMS / $TOTAL_ITEMS items complete"
    echo ""

    if [ "$REMAINING" -eq 0 ]; then
        echo "🎉 PRD complete! All items passing."
        exit 0
    fi

    # In AFK mode, continue automatically
    if [ "$MODE" = "AFK" ] && [ "$i" -lt "$ITERATIONS" ]; then
        echo "Continuing to next iteration..."
        echo ""
    fi
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🏁 Ralph loop finished"
echo "   Completed iterations: $ITERATIONS"
echo "   PRD items remaining: $REMAINING / $TOTAL_ITEMS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
