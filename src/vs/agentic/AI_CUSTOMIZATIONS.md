# AI Customization Editor – Design Document

This document describes the current AI customization experience in this branch: a form-based editor for AI customization files plus management and tree views that surface items across worktree, user, and extension storage.

---

## Existing Editor Patterns in VS Code

### Settings Editor (Form-based, schema-driven)
**Files**: [settingsEditor2.ts](../src/vs/workbench/contrib/preferences/browser/settingsEditor2.ts), [settingsTree.ts](../src/vs/workbench/contrib/preferences/browser/settingsTree.ts)

| Aspect | Pattern |
|--------|---------|
| Layout | `SplitView` with TOC tree (left) + settings list (right) |
| Renderers | Template-based: `SettingBoolRenderer`, `SettingEnumRenderer`, `SettingTextRenderer`, etc. |
| Data Flow | User edits → `onDidChangeSetting` → debounced `configurationService.updateValue()` |
| Validation | Schema-driven type checking + per-setting `validator` function |
| State | Memento persists search query, scope, scroll position |

**Key takeaway**: Use `SplitView`, tree-based navigation, and typed renderers per field type.

---

### Keybindings Editor (Table + capture overlay)
**File**: [keybindingsEditor.ts](../src/vs/workbench/contrib/preferences/browser/keybindingsEditor.ts)

| Aspect | Pattern |
|--------|---------|
| Layout | Search header + table body + capture overlay |
| Capture Mode | Full-screen overlay intercepts keystrokes without losing context |
| Data Flow | Edits write to `keybindings.json` via `IKeybindingEditingService` |

**Key takeaway**: Overlay capture pattern useful for defining agent triggers or tool shortcuts.

---

### Webview-based Editors (Release Notes, Extension Editor)
**Files**: [webviewEditorInput.ts](../src/vs/workbench/contrib/webviewPanel/browser/webviewEditorInput.ts), [releaseNotesEditor.ts](../src/vs/workbench/contrib/update/browser/releaseNotesEditor.ts)

| Aspect | Pattern |
|--------|---------|
| Input | `WebviewInput` or `LazilyResolvedWebviewEditorInput` |
| Communication | `webview.postMessage()` ↔ `webview.onMessage` |
| Dirty State | Implement `ICustomEditorModel` with `onDidChangeDirty` |
| State | `acquireVsCodeApi().setState/getState()` inside webview |

**Key takeaway**: Webviews enable rich HTML/CSS UI and can communicate bidirectionally with the host.

---

### Custom Editor Registration
**Files**: [editorResolverService.ts](../src/vs/workbench/services/editor/browser/editorResolverService.ts), [customEditors.ts](../src/vs/workbench/contrib/customEditor/browser/customEditors.ts)

```typescript
editorResolverService.registerEditor(
    '*.prompt.md',  // glob pattern
    {
        id: 'aiCustomization.editor',
        label: 'AI Customization Editor',
        priority: RegisteredEditorPriority.default,
    },
    { singlePerResource: true },
    {
        createEditorInput: ({ resource }, group) => ({
            editor: instantiationService.createInstance(AICustomizationEditorInput, resource),
        }),
    }
);
```

---

## Current Architecture

### File Structure (Agentic)

```
src/vs/agentic/contrib/aiCustomizationEditor/browser/
├── aiCustomizationEditor.contribution.ts   # Editor registration and serializer
├── aiCustomizationEditor.ts                # IDs + layout constants
├── fields/
│   └── fieldRenderers.ts                   # Field renderers + section renderer
├── input/
│   └── aiCustomizationEditorInput.ts       # EditorInput + model
├── pane/
│   └── aiCustomizationEditorPane.ts        # SplitView editor + TOC
└── media/
    └── aiCustomizationEditor.css

src/vs/agentic/contrib/aiCustomizationManagement/browser/
├── aiCustomizationManagement.contribution.ts   # Commands + context menus
├── aiCustomizationManagement.ts                # IDs + context keys
├── aiCustomizationManagementEditor.ts          # SplitView list/editor
├── aiCustomizationManagementEditorInput.ts     # Singleton input
├── aiCustomizationListWidget.ts                # Search + grouped list
├── customizationCreatorService.ts              # AI-guided creation flow
├── mcpListWidget.ts                            # MCP servers section
└── media/
    └── aiCustomizationManagement.css

src/vs/agentic/contrib/aiCustomizationTreeView/browser/
├── aiCustomizationTreeView.contribution.ts     # View + actions
├── aiCustomizationTreeView.ts                  # IDs + menu IDs
├── aiCustomizationTreeViewViews.ts             # Tree data source + view
├── aiCustomizationTreeViewIcons.ts             # Icons
└── media/
    └── aiCustomizationTreeView.css
```

---

## Service Alignment (Required)

AI customizations must lean on existing VS Code services with well-defined interfaces. This avoids duplicated parsing logic, keeps discovery consistent across the workbench, and ensures prompt/hook behavior stays authoritative.

Browser compatibility is required. Do not use Node.js APIs; rely on VS Code services that work in browser contexts.

Key services to rely on:
- Prompt discovery, parsing, and lifecycle: [src/vs/workbench/contrib/chat/common/promptSyntax/service/promptsService.ts](../workbench/contrib/chat/common/promptSyntax/service/promptsService.ts)
- Active session scoping for worktree filtering: [src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsService.ts](../workbench/contrib/chat/browser/agentSessions/agentSessionsService.ts)
- MCP servers and tool access: [src/vs/workbench/contrib/mcp/common/mcpService.ts](../workbench/contrib/mcp/common/mcpService.ts)
- MCP management and gallery: [src/vs/platform/mcp/common/mcpManagement.ts](../platform/mcp/common/mcpManagement.ts)
- Chat models and session state: [src/vs/workbench/contrib/chat/common/chatService/chatService.ts](../workbench/contrib/chat/common/chatService/chatService.ts)
- File and model plumbing: [src/vs/platform/files/common/files.ts](../platform/files/common/files.ts), [src/vs/editor/common/services/resolverService.ts](../editor/common/services/resolverService.ts)

## Implemented Experience

### Form-Based Editor (Current)


**Implementation notes**:
- `EditorPane` renders a header + `SplitView` with TOC on the left and fields on the right.
- Field renderers cover text, multiline, array, checkbox, and readonly values.
- TOC sections and field definitions are driven by `PromptsType` (agents/skills/instructions/prompts).
- Save/Revert buttons are wired to the editor model, with dirty state tracked in the input/model.

---

### Management Editor (Current)

- A singleton editor surfaces Agents, Skills, Instructions, Prompts, Hooks, MCP Servers, and Models.
- Prompts-based sections use a grouped list (Worktree/User/Extensions) with search, context menus, and an embedded editor.
- Embedded editor uses a full `CodeEditorWidget` and auto-commits worktree files on exit (agent session workflow).
- Creation supports manual or AI-guided flows; AI-guided creation opens a new chat with hidden system instructions.

### Tree View (Current)

- Unified sidebar tree with Type -> Storage -> File hierarchy.
- Auto-expands categories to reveal storage groups.
- Context menus provide Open, Open as Text, and Run Prompt.

### Additional Surfaces (Current)

- Overview view provides counts and deep-links into the management editor.
- Management list groups by storage with empty states, git status, and path copy actions.

---

## Editor Infrastructure (Current)

### AICustomizationEditorInput

```typescript
The editor model reads file content via `IFileService`, parses with `PromptFileParser`, and exposes helper getters for name, description, model, tools, applyTo, and body.
```

### AICustomizationEditorPane

```typescript
The editor pane renders a header with Save/Revert buttons, then a `SplitView` with TOC and fields. TOC entries and section layout vary by prompt type.
```

### Registration (Current)

```typescript
// aiCustomizationEditor.contribution.ts
The AI Customization Editor is registered as an optional editor for AI customization files (`.prompt.md`, `.agent.md`, `.instructions.md`, `SKILL.md`) and is only available when `ChatContextKeys.enabled` is true.
```

---

## AI Feature Gating

All commands and UI must respect `ChatContextKeys.enabled`:

```typescript
All entry points (editor resolver, view contributions, commands) respect `ChatContextKeys.enabled`.
```

---

## Data Flow (Editor)

```
┌──────────────┐    parse     ┌───────────────┐    render    ┌────────────┐
│ .agent.md    │ ──────────▶  │ Parsed Model  │ ──────────▶  │ Form UI    │
│ (file)       │              │ (frontmatter  │              │            │
└──────────────┘              │  + body AST)  │              └────────────┘
    ▲                      └───────────────┘                    │
    │                             │                             │
    │    serialize                │ onDidChangeDirty            │ user edit
    │                             ▼                             │
    │                      ┌───────────────┐                    │
    └───────────────────── │ Editor Input  │ ◀──────────────────┘
                  └───────────────┘
```

---

## Validation and Gaps

- The editor currently updates only body content on field changes; full frontmatter serialization is still a gap.
- Inline validation and schema-based constraints are not implemented yet.

---

## References

- [Settings Editor](../src/vs/workbench/contrib/preferences/browser/settingsEditor2.ts)
- [Keybindings Editor](../src/vs/workbench/contrib/preferences/browser/keybindingsEditor.ts)
- [Webview Editor](../src/vs/workbench/contrib/webviewPanel/browser/webviewEditorInput.ts)
- [Custom Editor Registration](../src/vs/workbench/services/editor/browser/editorResolverService.ts)
- [AI Customization Editor (agentic)](../src/vs/agentic/contrib/aiCustomizationEditor/browser/)
- [AI Customization Management (agentic)](../src/vs/agentic/contrib/aiCustomizationManagement/browser/)
- [AI Customization Overview View](../src/vs/agentic/contrib/aiCustomizationManagement/browser/aiCustomizationOverviewView.ts)
- [AI Customization Tree View (agentic)](../src/vs/agentic/contrib/aiCustomizationTreeView/browser/)
- [IPromptsService](../src/vs/workbench/contrib/chat/common/promptSyntax/service/promptsService.ts)
