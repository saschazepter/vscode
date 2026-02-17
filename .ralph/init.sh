#!/bin/bash
# Ralph Loop Initialization Script
# Creates the progress file and sets up the environment for a Ralph loop

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

echo "🔧 Initializing Ralph Loop..."
echo "   Project root: $PROJECT_ROOT"

# Check if prd.json exists
if [ ! -f "prd.json" ]; then
    echo ""
    echo "⚠️  No prd.json found!"
    echo ""
    echo "   Start a planning session first:"
    echo "   1. Open a chat with the AI"
    echo "   2. Reference: @.ralph/PLANNING.md"
    echo "   3. Describe what you want to build"
    echo ""
    exit 1
fi

# Create or reset progress file
PROGRESS_FILE="ralph-progress.txt"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

if [ -f "$PROGRESS_FILE" ]; then
    echo "   Found existing $PROGRESS_FILE"
    read -p "   Reset progress file? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm "$PROGRESS_FILE"
        echo "   Removed existing progress file"
    else
        echo "   Keeping existing progress file"
    fi
fi

if [ ! -f "$PROGRESS_FILE" ]; then
    cat > "$PROGRESS_FILE" << EOF
# Ralph Progress Log
# Started: $TIMESTAMP
# PRD: prd.json

## Session Start
- Initialized Ralph loop
- Ready to begin implementation

---

EOF
    echo "   Created $PROGRESS_FILE"
fi

# Count PRD items
TOTAL_ITEMS=$(($(grep -c '"passes"' prd.json 2>/dev/null || echo 0)))
PASSING_ITEMS=$(($(grep -c '"passes": true' prd.json 2>/dev/null || echo 0)))

echo ""
echo "📋 PRD Status:"
echo "   Total items: $TOTAL_ITEMS"
echo "   Passing: $PASSING_ITEMS"
echo "   Remaining: $((TOTAL_ITEMS - PASSING_ITEMS))"

# Create a git checkpoint if there are uncommitted changes
if git rev-parse --git-dir > /dev/null 2>&1; then
    if [ -n "$(git status --porcelain)" ]; then
        echo ""
        read -p "📸 Create git checkpoint commit? (Y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Nn]$ ]]; then
            git add -A
            git commit -m "chore: ralph loop checkpoint - $(date '+%Y-%m-%d %H:%M')"
            echo "   Created checkpoint commit"
        fi
    else
        echo ""
        echo "📸 Git status: clean (no checkpoint needed)"
    fi
fi

echo ""
echo "✅ Ralph loop initialized!"
echo ""
echo "   Next steps:"
echo "   1. Run HITL mode:  ./.ralph/ralph.sh once"
echo "   2. Or AFK mode:    ./.ralph/ralph.sh 5"
echo ""
