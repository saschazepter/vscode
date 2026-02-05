# Auto-Memory Feature Specification

## Overview

Build an automatic memory extraction system that periodically analyzes chat history using a lightweight model (Haiku), stores facts at workspace/user scope, then surfaces those facts as **merge suggestions** — recommending where each memory should integrate into existing customizations (agents, skills, instructions, prompts, hooks). Users see notifications and a dedicated "Memory Suggestions" UI in the management editor to review and apply improvements to their customizations.

## Core Concept: Merge Suggestions

Unlike ephemeral context injection, memories become **suggestions for improving permanent customizations**. The system:

1. Extracts facts from chat conversations
2. Analyzes facts against existing customization files
3. Suggests where each fact should be merged (e.g., "Add this convention to `coding.instructions.md`")
4. User reviews and applies suggestions via a merge UI

This improves the user's customization artifacts over time rather than just adding hidden context.

---

## Configuration

### Primary Setting: `chat.memory.suggestionMode`

Controls how aggressively Copilot suggests improvements to AI customizations based on chat history.

| Mode | Extraction Trigger | Notification Behavior | Use Case |
|------|-------------------|----------------------|----------|
| `off` | Never | Never | User wants no memory features |
| `eager` | After every completed chat turn | Immediate per-suggestion | Power users who want real-time learning |
| `occasional` | Every 15-30 minutes | Batched (e.g., "5 new suggestions") | **Default** - balanced experience |
| `manual` | On `Reconcile` command only | Never (user pulls) | Users who want full control |

**Important**: All modes except `off` still persist raw facts to storage. Mode only affects when *suggestions* are generated and surfaced.

### Setting Schema

```json
{
  "chat.memory.suggestionMode": {
    "type": "string",
    "enum": ["off", "eager", "occasional", "manual"],
    "enumDescriptions": [
      "Disabled. No memory extraction or tracking.",
      "Eager. Analyze every chat turn and suggest customization improvements immediately.",
      "Occasional. Periodically analyze chat history and batch suggestions.",
      "Manual. Track facts silently. Run 'Reconcile Memory Suggestions' command to review."
    ],
    "default": "occasional",
    "description": "Controls how aggressively Copilot suggests improvements to your AI customizations based on chat history."
  }
}
```

---

## Architecture

### Heuristics & Prompting

**Extraction heuristics**
- Scope routing: workspace if the fact references files/paths/tools/CI/env vars; user if it is about personal style/habits with no repo tie; ambiguous → workspace when any file/path/tool mention exists.
- Fact quality: must be durable and actionable; drop transient states ("tests failing now"); reject secrets/tokens/emails/URLs that look like credentials; favor concise normative statements.
- Deduplication: normalize whitespace/case; merge if semantic similarity is high and scopes match; keep earliest citation and union citations.
- Confidence: boost when user upvoted, when multiple mentions occur, or phrased declaratively; lower for hedged language or downvoted responses.

**Extraction prompt (Haiku)**
- System goal: extract durable, actionable facts for future coding; separate workspace vs user; return strict JSON.
- Output schema: `{ "facts": [{ "content": "", "reason": "", "citations": [], "scope": "workspace|user" }] }`.
- Guardrails: exclude secrets/tokens/emails; exclude transient states; prefer short imperative/declarative facts.
- Routing hint: scope=workspace if files/paths/tools/CI are referenced, else scope=user.

**Suggestion matching heuristics**
- Target selection priority: (1) Instructions (`applyTo` match) → (2) Agent persona/behavior → (3) Skill capability/steps → (4) Prompt reusable snippet → (5) Hook automation → (6) New file if no good match.
- Placement: Instructions into nearest heading/"Conventions"; Agents into rules/persona block; Skills into steps/checklists; Prompts as titled snippet; Hooks into event-specific entry.
- Merge aggressiveness: high similarity → replace/merge; medium → add alongside with diff; low → new bullet/section.

**Pruning & batching**
- Only promote suggestions above confidence/dup thresholds; batch similar suggestions by target file/theme; in eager mode debounce per-turn extraction (~300–500ms) to avoid spam.

**Provenance**
- Always retain citations (file paths or chat turn references) and show them in the Memory UI to aid trust and conflict resolution.

### Folder Structure

Create isolated folders following existing conventions:

```
src/vs/workbench/contrib/chat/
├── common/chatMemory/                           # Interfaces (no browser deps)
│   ├── chatMemory.ts                            # IMemoryFact, IMemorySuggestion interfaces
│   ├── chatMemoryService.ts                     # IChatMemoryService interface
│   ├── chatMemoryExtractionService.ts           # IChatMemoryExtractionService interface
│   └── chatMemorySuggestionService.ts           # IChatMemorySuggestionService interface
│
└── browser/aiCustomizationMemory/               # Implementation
    ├── aiCustomizationMemory.ts                 # Constants, IDs, section definition
    ├── aiCustomizationMemory.contribution.ts    # Service + UI registration
    ├── chatMemoryConfiguration.ts               # Settings schema + helpers
    ├── chatMemoryService.ts                     # Core memory storage CRUD
    ├── chatMemoryExtractionService.ts           # Background extraction logic
    ├── chatMemorySuggestionService.ts           # Fact-to-customization matching
    ├── memoryListWidget.ts                      # UI widget for Memory section
    ├── memoryIcons.ts                           # Icon registration
    └── media/
        └── aiCustomizationMemory.css            # Styling
```

### Data Model

#### `IMemoryFact`

Core fact extracted from chat history.

```typescript
interface IMemoryFact {
  readonly id: string;                    // Unique identifier
  readonly content: string;               // The fact text
  readonly reason: string;                // Why it was stored
  readonly citations?: string[];          // File paths/line numbers from conversation
  readonly timestamp: number;             // When extracted
  readonly scope: MemoryScope;            // 'workspace' | 'user'
  readonly sourceSessionId: string;       // Chat session it came from
  readonly confidence: number;            // 0-1 extraction confidence
}

type MemoryScope = 'workspace' | 'user';
```

#### `IMemorySuggestion`

A fact matched to a customization target.

```typescript
interface IMemorySuggestion extends IMemoryFact {
  readonly targetType: SuggestionTargetType;
  readonly targetUri?: URI;               // Existing file to modify, or undefined for new file
  readonly suggestedFileName?: string;    // If creating new file
  readonly suggestedMergeContent: string; // How the fact would be integrated
  readonly status: SuggestionStatus;
}

type SuggestionTargetType = 'agent' | 'skill' | 'instructions' | 'prompt' | 'hook' | 'newFile';
type SuggestionStatus = 'pending' | 'applied' | 'dismissed';
```

---

## Services

### `IChatMemoryService` (Storage)

Manages CRUD operations for facts.

**Storage Locations**:
- Workspace facts: `.github/memories/facts.json`
- User facts: Profile storage via `IStorageService`

**Interface**:
```typescript
interface IChatMemoryService {
  readonly onDidChangeMemories: Event<void>;

  listFacts(scope?: MemoryScope): Promise<IMemoryFact[]>;
  addFact(fact: Omit<IMemoryFact, 'id'>): Promise<IMemoryFact>;
  removeFact(id: string): Promise<void>;
  updateFact(id: string, updates: Partial<IMemoryFact>): Promise<void>;

  getLastExtractionTime(scope: MemoryScope): number | undefined;
  setLastExtractionTime(scope: MemoryScope, time: number): void;
}
```

### `IChatMemoryExtractionService` (Extraction)

Background job that analyzes chat sessions.

**Mode-Aware Behavior**:
- `eager`: Subscribe to `ChatModel.onDidChange` for `completedRequest` events
- `occasional`: Timer-based (configurable interval, default 15 min)
- `manual`: Only triggered by `chat.memory.reconcile` command

**Extraction Logic**:
1. Get unprocessed sessions since last extraction
2. Call Haiku-class model with extraction prompt
3. Parse structured JSON response
4. Route facts: codebase conventions → workspace, personal preferences → user
5. Store via `IChatMemoryService`

**Extraction Prompt Template**:
```
Analyze this chat conversation and extract actionable facts that would help with future coding or code review tasks.

Separate facts into:
1. WORKSPACE facts: Conventions, patterns, or knowledge specific to this codebase
2. USER facts: Personal preferences, coding style, or workflow preferences

For each fact, provide:
- content: The fact itself (concise, actionable)
- reason: Why this is worth remembering
- citations: Relevant file paths or code snippets mentioned

Output JSON: { "facts": [{ "content": "...", "reason": "...", "citations": [...], "scope": "workspace"|"user" }] }

Filter criteria:
- Must be actionable for future tasks
- Must be durable (not session-specific)
- Must not contain secrets or sensitive data
```

### `IChatMemorySuggestionService` (Matching)

Maps facts to customization targets.

**Interface**:
```typescript
interface IChatMemorySuggestionService {
  readonly onDidAddSuggestion: Event<IMemorySuggestion>;
  readonly onDidChangeSuggestions: Event<void>;

  listSuggestions(status?: SuggestionStatus): Promise<IMemorySuggestion[]>;
  generateSuggestionsForFact(fact: IMemoryFact): Promise<IMemorySuggestion[]>;
  applySuggestion(id: string): Promise<void>;
  dismissSuggestion(id: string): Promise<void>;

  getPendingSuggestionCount(): number;
}
```

**Matching Logic**:
1. Load existing customizations via `IPromptsService`
2. For each fact, use Haiku to determine best target:
   - Match by `applyTo` patterns in `.instructions.md` files
   - Match by agent personality/rules in `.agent.md` files
   - Match by skill capabilities in `SKILL.md` files
   - If no good match: suggest creating new file
3. Generate `suggestedMergeContent` showing how fact integrates

---

## Pruning Strategy

Prevents unbounded fact growth.

**Limits**:
- 50 workspace facts (configurable)
- 100 user facts (configurable)

**Pruning Algorithm**:
```
score = recency_weight * age_score
      + user_signal_weight * vote_score
      + relevance_weight * usage_score
```

Where:
- `age_score`: Newer facts score higher (exponential decay)
- `vote_score`: Facts from upvoted responses get boost
- `usage_score`: Facts that led to applied suggestions score higher

**LLM Deduplication**:
- Periodic Haiku call to merge similar facts
- e.g., "Use tabs not spaces" + "Indent with tabs" → single consolidated fact

---

## UI Integration

### Memory Section in Management Editor

Add "Memory" to `AICustomizationManagementSection` alongside Agents, Skills, Instructions, etc.

**Update Files**:
- `aiCustomizationManagement/aiCustomizationManagement.ts`: Add `Memory: 'memory'` to section enum
- `aiCustomizationManagement/aiCustomizationManagementEditor.ts`: Add Memory content container and widget

### Memory List Widget

Shows pending suggestions grouped by target type.

**Layout**:
```
┌─────────────────────────────────────────────────────────────┐
│ Memory Suggestions                    [Reconcile] [Settings]│
│ Mode: Occasional • Last run: 5 min ago • 3 pending          │
├─────────────────────────────────────────────────────────────┤
│ ▼ Instructions (2)                                          │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ "Use tabs for indentation"                          │   │
│   │ → Merge into coding.instructions.md                 │   │
│   │ [Apply] [Edit] [Dismiss]                            │   │
│   └─────────────────────────────────────────────────────┘   │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ "Prefer async/await over Promise.then()"            │   │
│   │ → Merge into coding.instructions.md                 │   │
│   │ [Apply] [Edit] [Dismiss]                            │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│ ▼ New Files (1)                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ "Project uses pnpm for package management"          │   │
│   │ → Create new tooling.instructions.md                │   │
│   │ [Apply] [Edit] [Dismiss]                            │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Empty States**:
- Mode `off`: "Memory is disabled. [Enable in Settings]"
- Mode `manual` with no suggestions: "No suggestions yet. [Run Reconcile]"
- No pending suggestions: "All caught up! ✓"

### Agent Sessions View Integration

Add Memory shortcut to the CUSTOMIZATIONS section in `agentSessions/experiments/agentSessionsViewPane.ts`.

```typescript
// In shortcuts array:
{
  label: localize('memory', "Memory"),
  icon: memoryIcon,
  action: () => this.openAICustomizationSection(AICustomizationManagementSection.Memory),
  getCount: () => this.memorySuggestionService.getPendingSuggestionCount()
}
```

Shows badge with pending suggestion count.

---

## Commands

### `chat.memory.reconcile`

**Title**: "Copilot: Reconcile Memory Suggestions"

**Behavior by Mode**:
- `manual`: Runs extraction → generates suggestions → opens Memory section
- `eager`/`occasional`: Just opens Memory section with existing suggestions
- `off`: Shows "Memory is disabled" notification with settings link

**Precondition**: `ChatContextKeys.enabled && chat.memory.suggestionMode !== 'off'`

---

## Notifications

### Suggestion Added Notification

Triggered by `IChatMemorySuggestionService.onDidAddSuggestion`.

**Behavior by Mode**:
| Mode | Trigger | Message |
|------|---------|---------|
| `eager` | Each suggestion | "Copilot learned: '{fact}'. [Review] [Dismiss]" |
| `occasional` | Batch threshold (5) or session end | "Copilot has 5 suggestions to improve your customizations. [Review]" |
| `manual` | Never | - |

**Actions**:
- "Review": Opens Memory section in Management Editor
- "Dismiss": Marks notification as read (suggestions remain pending)

---

## Apply Suggestion Flow

When user clicks "Apply" on a suggestion:

1. **Open Diff Editor**: Show target file with proposed change highlighted
2. **User Review**: User can accept as-is, edit, or cancel
3. **Apply Edit**: Use `IEditorService` + `TextEdit` to insert content
4. **Update Status**: Mark suggestion as `applied`
5. **Optional**: Prompt to apply similar suggestions ("Apply 2 similar suggestions?")

For new files:
1. Use `IPromptsService.createPromptFile()` pattern
2. Open newly created file for review

---

## Implementation Steps

### Phase 1: Foundation
1. Create folder structure under `chat/common/chatMemory/` and `chat/browser/aiCustomizationMemory/`
2. Define interfaces: `IMemoryFact`, `IMemorySuggestion`
3. Implement `chatMemoryConfiguration.ts` with settings schema
4. Register configuration in contribution

### Phase 2: Storage Service
5. Implement `IChatMemoryService` with workspace/user storage
6. Add `.github/memories/facts.json` file handling
7. Implement pruning logic

### Phase 3: Extraction Service
8. Implement `IChatMemoryExtractionService`
9. Hook into chat session completion events
10. Implement extraction prompt and response parsing
11. Add mode-aware scheduling (eager/occasional/manual)

### Phase 4: Suggestion Service
12. Implement `IChatMemorySuggestionService`
13. Integrate with `IPromptsService` for customization discovery
14. Implement fact-to-target matching logic
15. Generate merge content suggestions

### Phase 5: UI Integration
16. Add `Memory` to `AICustomizationManagementSection`
17. Create `MemoryListWidget`
18. Add Memory content container to Management Editor
19. Add Memory shortcut to Agent Sessions view pane

### Phase 6: Commands & Notifications
20. Register `chat.memory.reconcile` command
21. Implement notification contribution
22. Add apply suggestion flow with diff editor

### Phase 7: Polish
23. Add icons (`Codicon.lightbulbSparkle` or similar)
24. Add CSS styling
25. Add telemetry events
26. Write unit tests

---

## Verification Checklist

- [ ] **Build**: `VS Code - Build` task completes without errors
- [ ] **Isolated imports**: Memory folder only imports from shared constants, not other aiCustomization folders
- [ ] **Test mode switching**: Change `chat.memory.suggestionMode` at runtime, verify behavior changes without restart
- [ ] **Test eager mode**: Send chat message, verify immediate suggestion notification
- [ ] **Test occasional mode**: Verify extraction runs on interval, notifications batch
- [ ] **Test manual mode**: Verify no notifications, reconcile command works
- [ ] **Test off mode**: Verify no extraction, no storage writes
- [ ] **Test Agent Sessions integration**: Open Agent Sessions view, verify Memory shortcut appears with badge
- [ ] **Test apply suggestion**: Click Apply, verify diff editor opens, apply works

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Default to `occasional` | Balances usefulness with non-intrusiveness |
| `manual` still tracks facts | Enables "catch up" reconciliation without losing history |
| Mode controls suggestions, not raw storage | Even in `manual`, facts are captured for later analysis |
| Reconcile command in all active modes | Useful for on-demand review regardless of mode |
| Workspace/user scope routing | Codebase conventions shouldn't pollute user profile; personal preferences shouldn't pollute workspace |
| Merge UI over auto-inject | User maintains control, improves permanent customizations rather than ephemeral context |
| Haiku-class model for extraction | Fast, cheap, sufficient for fact extraction/matching (not code generation) |
| Isolated folder structure | Matches existing `aiCustomizationEditor/`, `aiCustomizationTreeView/`, `aiCustomizationManagement/` convention |

---

## Future Considerations

- **Memory sharing**: Share workspace memories via `.github/memories/` in version control
- **Memory import/export**: Export user memories to file, import on new machine
- **Memory conflicts**: Handle contradictory facts (e.g., "use tabs" vs "use spaces")
- **Memory provenance**: Show which chat session each fact came from
- **Memory search**: Full-text search across all memories
- **Memory categories**: Auto-categorize facts (style, testing, architecture, etc.)
