# AI Customization Editor Specification

## Overview

The AI Customization Editor is a form-based editor for AI customization files (`.agent.md`, `.instructions.md`, `.prompt.md`, `SKILL.md`). It presents a split-pane UI with a TOC on the left and field-based sections on the right.

**Location:** `src/vs/agentic/contrib/aiCustomizationEditor/browser/`

**Purpose:** Provide a structured editing experience while still allowing users to open files as plain text when needed.

## Architecture

### Component Hierarchy

```
AICustomizationEditorPane (EditorPane)
├── Header (title + Save/Revert)
└── SplitView (Horizontal orientation)
    ├── TOC Panel (Left)
    │   └── WorkbenchAsyncDataTree
    │       ├── TocDataSource
    │       ├── TocTreeDelegate
    │       └── TocSectionRenderer
    └── Editor Panel (Right)
        └── DomScrollableElement (scrollable content)
            └── SectionRenderer
                └── Field Renderers (text, multiline, array, checkbox, readonly)
```

### File Structure

```
aiCustomizationEditor/browser/
├── aiCustomizationEditor.ts              # Constants and IDs
├── aiCustomizationEditor.contribution.ts # Editor registration and serializer
├── input/
│   └── aiCustomizationEditorInput.ts     # EditorInput + model
├── pane/
│   └── aiCustomizationEditorPane.ts      # SplitView editor + TOC
├── fields/
│   └── fieldRenderers.ts                 # Field and section renderers
└── media/
    └── aiCustomizationEditor.css         # Styling
```

## Key Components

### AICustomizationEditorInput

**Extends:** `EditorInput`

**Responsibilities:**
- Stores the file `URI` and prompt type derived from the filename.
- Resolves a model that loads/parses the file with `PromptFileParser`.
- Tracks dirty state via the model and exposes `save()`/`revert()`.

### AICustomizationEditorModel

**Extends:** `Disposable` (not `EditorModel`)

**Responsibilities:**
- Reads/writes the file via `IFileService`.
- Parses content via `PromptFileParser` and exposes helper getters.
- Tracks dirty state and raises `onDidChangeDirty`.

**Notes:**
- Field changes currently update body text only.
- Full frontmatter serialization is not implemented yet.

### AICustomizationEditorPane

**Extends:** `EditorPane`

**Responsibilities:**
- Renders a header with Save/Revert buttons.
- Creates a `SplitView` with TOC and field sections.
- Persists TOC width to profile storage.
 - Updates the header title to the model name.

**Layout:**
- TOC min width 140px, default 220px; editor min width 400px.
- Narrow mode (<660px) hides the TOC.
 - Double-clicking the sash resets TOC width to default.

### Field Renderers

Available renderers:
- `TextFieldRenderer`
- `MultilineFieldRenderer`
- `ArrayFieldRenderer`
- `CheckboxFieldRenderer`
- `ReadonlyFieldRenderer`

**Current usage:** text, multiline, and array are used; checkbox and readonly are available for future fields.

### Section Layout by Type

**Agent Files (`.agent.md`):**
1. Overview (name, description)
2. Behavior (instructions/body)
3. Model (model array)
4. Tools (tools array)

**Skill Files (`SKILL.md`):**
1. Overview (name, description)
2. Behavior (instructions/body)
3. Tools (tools array)

**Instructions Files (`.instructions.md`):**
1. Overview (name, description)
2. Content (instructions/body)
3. Apply To (applyTo)

**Prompt Files (`.prompt.md`):**
1. Overview (name, description)
2. Content (instructions/body)

## Registration & Integration

### Editor Registration

Registered as an optional editor for:
- `**/*.prompt.md`
- `**/*.agent.md`
- `**/*.instructions.md`
- `**/SKILL.md`

Available only when `ChatContextKeys.enabled` is true.

### Serialization

The editor input serializes the file `URI` to restore editor state on reload.

## Constants & IDs

```typescript
AI_CUSTOMIZATION_EDITOR_ID = 'workbench.editor.aiCustomizationEditor'
AI_CUSTOMIZATION_EDITOR_VIEW_TYPE = 'aiCustomization.editor'
AI_CUSTOMIZATION_EDITOR_TOC_WIDTH_KEY = 'aiCustomizationEditor.tocWidth'
```

## User Workflows

### Opening a File

1. User opens an AI customization file.
2. Resolver offers "AI Customization Editor" as an option.
3. Editor loads and parses content, renders sections, and updates the TOC.

### Editing and Saving

1. Field updates mark the model as dirty.
2. Save/Revert buttons become enabled.
3. Save writes the current content back to disk.

### Revert and Refresh

1. Revert restores file content from disk.
2. Field values and header title are refreshed from the parsed model.

### TOC Navigation

Selecting a TOC item scrolls to the corresponding section.

The TOC is a flat list of sections derived from `PromptsType` (no nested items).

## Integration Points

- `IFileService` for file I/O.
- `PromptFileParser` for parsing frontmatter and body.
- `IStorageService` for TOC width persistence.
- `IContextViewService` and `IHoverService` for input widgets and hover support.
- `IStorageService` for persisted TOC width.

## Service Alignment (Required)

AI customizations must lean on existing VS Code services with well-defined interfaces. The editor should not replicate prompt discovery or parsing logic.

Browser compatibility is required. Do not use Node.js APIs; rely on VS Code services that work in browser contexts.

Required services to prefer:
- Prompt discovery and metadata: [src/vs/workbench/contrib/chat/common/promptSyntax/service/promptsService.ts](../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.ts)
- Parsing and frontmatter conventions: [src/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts](../../../../workbench/contrib/chat/common/promptSyntax/promptFileParser.ts)
- File I/O and models: [src/vs/platform/files/common/files.ts](../../../../platform/files/common/files.ts), [src/vs/editor/common/services/resolverService.ts](../../../../editor/common/services/resolverService.ts)

## Known Gaps

- Full frontmatter serialization (only body updates are applied today).
- Inline validation and schema-driven constraints.
 - Field changes other than `instructions/body` do not update file content yet.

## Related Components

- AI Customization Management Editor
- AI Customization Tree View

---

*This specification documents the AI Customization Editor in `src/vs/agentic/contrib/aiCustomizationEditor/browser/`.*
