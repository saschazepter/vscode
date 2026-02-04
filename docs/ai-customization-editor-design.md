# AI Customization Editor – Design Document

This document outlines how to build a custom editor for AI customization artifacts (`.prompt.md`, `.agent.md`, `.instructions.md`, `SKILL.md`) in VS Code, informed by existing editor patterns and external UX inspirations.

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

## External UX Inspirations

| Reference | Key Ideas | Link |
|-----------|-----------|------|
| **OpenAI GPT Builder** | Left configure form + right live preview; capability toggles; iterative edit→apply→preview loop | [help.openai.com](https://help.openai.com/en/articles/8770868-gpt-builder-guide) |
| **LangGraph Studio** | Visual node canvas for agent steps; per-node probe/run; thread timeline | [github.com/langchain-ai/langgraph-studio](https://github.com/langchain-ai/langgraph-studio) |
| **Flowise** | Drag-and-drop block builder; property drawer per node; rapid preview | [github.com/FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise) |
| **Notion Prompt Gallery** | Searchable template cards; one-click duplicate; lightweight inline edit | [notion.com/templates](https://www.notion.com/templates/ai-prompt-library) |

---

## Proposed Architecture

### File Structure

```
src/vs/workbench/contrib/chat/browser/aiCustomizationEditor/
├── aiCustomizationEditor.contribution.ts   # Registration, commands
├── aiCustomizationEditorInput.ts           # EditorInput implementation
├── aiCustomizationEditorPane.ts            # EditorPane (main shell)
├── formView/
│   ├── formViewPane.ts                     # Form-based editing
│   ├── fieldRenderers.ts                   # Per-field renderers
│   └── validationService.ts                # Schema validation
├── sourceView/
│   └── sourceViewPane.ts                   # Raw markdown view
├── previewView/
│   └── previewPane.ts                      # Live run/preview
├── graphView/                              # Optional graph mode
│   └── graphPane.ts
└── media/
    └── aiCustomizationEditor.css
```

---

## Three Design Options

### Option 1: Form + Live Preview (GPT-Builder style)

```
┌─────────────────────────────────────────────────────────────────┐
│  [Icon] My Agent.agent.md          [Workspace ▾] [Run ▶] [⋯]   │
├─────────────────────────────┬───────────────────────────────────┤
│                             │                                   │
│  ┌─ Overview ─────────────┐ │  ┌─ Preview ────────────────────┐ │
│  │ Name: [My Agent      ] │ │  │                              │ │
│  │ Description:           │ │  │  User: How do I build X?    │ │
│  │ [Multi-line input    ] │ │  │                              │ │
│  └────────────────────────┘ │  │  Agent: Here's how...        │ │
│                             │  │                              │ │
│  ┌─ Behavior ─────────────┐ │  │                              │ │
│  │ Instructions:          │ │  │                              │ │
│  │ [Monaco editor       ] │ │  │  [Send test message...]      │ │
│  │                        │ │  │                              │ │
│  └────────────────────────┘ │  └──────────────────────────────┘ │
│                             │                                   │
│  ┌─ Model ────────────────┐ │  ┌─ Source ─────────────────────┐ │
│  │ Model(s): [gpt-4o ▾ +] │ │  │  [Show raw markdown]         │ │
│  └────────────────────────┘ │  └──────────────────────────────┘ │
│                             │                                   │
│  ┌─ Tools ────────────────┐ │                                   │
│  │ ☑ Web Search           │ │                                   │
│  │ ☑ File Operations      │ │                                   │
│  │ ☐ Terminal             │ │                                   │
│  └────────────────────────┘ │                                   │
│                             │                                   │
└─────────────────────────────┴───────────────────────────────────┘
```

**Implementation approach**:
- Extend `EditorPane` with native DOM (like Settings Editor)
- Use `SplitView` with form pane + preview pane
- Form fields map to frontmatter schema; use `IPromptsService` parser
- Preview panel embeds a mini chat widget; reuses `IChatService`
- Dirty state tracks form changes; save writes frontmatter + body

---

### Option 2: Form + Graph Mode (LangGraph-inspired)

```
┌─────────────────────────────────────────────────────────────────┐
│  [Icon] My Skill           [Form] [Graph] [Source]    [Run ▶]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────┐      ┌─────────┐      ┌─────────┐                 │
│  │  Start  │─────▶│ Search  │─────▶│ Respond │                 │
│  └─────────┘      │  Tool   │      └─────────┘                 │
│                   └─────────┘                                   │
│                         │                                       │
│                         ▼                                       │
│                   ┌─────────┐                                   │
│                   │  Code   │                                   │
│                   │  Tool   │                                   │
│                   └─────────┘                                   │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  Properties: Search Tool                                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Name: [web_search        ]                                 │ │
│  │ Description: [Searches the web for information]            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation approach**:
- Add tabs: Form | Graph | Source
- Graph view uses a lightweight canvas (could be webview or native SVG)
- Nodes represent frontmatter sections (tools, routes, commands)
- Edges define execution order; edits round-trip to frontmatter
- Property drawer appears when selecting a node
- "Probe" button per node runs just that step

---

### Option 3: Template Gallery + Inline Widgets (Apps-SDK style)

```
┌─────────────────────────────────────────────────────────────────┐
│  🔍 Search templates...                    [Filter ▾] [New ▾]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ Code Review │  │ Doc Writer  │  │ Test Agent  │             │
│  │   Agent     │  │   Agent     │  │             │             │
│  │             │  │             │  │             │             │
│  │ [Duplicate] │  │ [Duplicate] │  │ [Duplicate] │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│                                                                 │
│  ──────────────────────────────────────────────────────────────│
│                                                                 │
│  ┌─ Overview ──────────────────────────────────────────────┬─┐ │
│  │ Name: [Code Review Agent]                               │▾│ │
│  │ Description: Reviews code for best practices            │ │ │
│  └─────────────────────────────────────────────────────────┴─┘ │
│                                                                 │
│  ┌─ Instructions ──────────────────────────────────────────┬─┐ │
│  │ You are a code review assistant...                      │▾│ │
│  │                                        [Try it ▶]       │ │ │
│  └─────────────────────────────────────────────────────────┴─┘ │
│                                                                 │
│  ┌─ Docs ──────────────────────────────────────────────────┬─┐ │
│  │ 💡 Tip: Use @workspace to reference project files       │ │ │
│  └─────────────────────────────────────────────────────────┴─┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation approach**:
- Entry point: searchable gallery (quick pick or embedded grid)
- Templates loaded from extension-contributed prompts + built-in examples
- Editor body: collapsible card stack (like extension editor features tab)
- Per-card "Try it" button runs inline and shows result below
- Docs rail with contextual tips interpolated per card
- Webview-based for rich card rendering; postMessage for actions

---

## Common Infrastructure

### AICustomizationEditorInput

```typescript
class AICustomizationEditorInput extends EditorInput {
    static readonly ID = 'workbench.editors.aiCustomizationEditor';

    constructor(
        readonly resource: URI,
        @IPromptsService private readonly promptsService: IPromptsService,
    ) { super(); }

    get typeId(): string { return AICustomizationEditorInput.ID; }
    get editorId(): string { return 'aiCustomization.editor'; }

    override getName(): string {
        return basename(this.resource);
    }

    override isDirty(): boolean {
        return this._dirty;
    }

    async resolve(): Promise<AICustomizationModel> {
        const parsed = await this.promptsService.parsePromptFile(this.resource);
        return new AICustomizationModel(this.resource, parsed);
    }
}
```

### AICustomizationEditorPane

```typescript
class AICustomizationEditorPane extends EditorPane {
    static readonly ID = 'workbench.editor.aiCustomizationEditor';

    private splitView: SplitView;
    private formPane: FormViewPane;
    private previewPane: PreviewPane;

    protected createEditor(parent: HTMLElement): void {
        this.splitView = new SplitView(parent, { orientation: Orientation.HORIZONTAL });
        this.formPane = this._register(this.instantiationService.createInstance(FormViewPane));
        this.previewPane = this._register(this.instantiationService.createInstance(PreviewPane));

        this.splitView.addView(this.formPane, Sizing.Distribute);
        this.splitView.addView(this.previewPane, Sizing.Distribute);
    }

    async setInput(input: AICustomizationEditorInput, ...): Promise<void> {
        await super.setInput(input, ...);
        const model = await input.resolve();
        this.formPane.setModel(model);
        this.previewPane.setModel(model);
    }
}
```

### Registration

```typescript
// aiCustomizationEditor.contribution.ts
class AICustomizationEditorContribution extends Disposable {
    constructor(
        @IEditorResolverService editorResolverService: IEditorResolverService,
        @IInstantiationService instantiationService: IInstantiationService,
    ) {
        super();

        const patterns = ['*.prompt.md', '*.agent.md', '*.instructions.md', '**/SKILL.md'];
        for (const pattern of patterns) {
            this._register(editorResolverService.registerEditor(
                pattern,
                {
                    id: 'aiCustomization.editor',
                    label: localize('aiCustomizationEditor', 'AI Customization Editor'),
                    priority: RegisteredEditorPriority.default,
                },
                { singlePerResource: true },
                {
                    createEditorInput: ({ resource }) => ({
                        editor: instantiationService.createInstance(AICustomizationEditorInput, resource),
                    }),
                }
            ));
        }
    }
}

// Register pane
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
    EditorPaneDescriptor.create(AICustomizationEditorPane, AICustomizationEditorPane.ID, 'AI Customization'),
    [new SyncDescriptor(AICustomizationEditorInput)]
);
```

---

## AI Feature Gating

All commands and UI must respect `ChatContextKeys.enabled`:

```typescript
// Hide editor registration when AI disabled
registerEditor: condition = ContextKeyExpr.equals(ChatContextKeys.enabled.key, true)

// Toolbar actions
MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
    command: { id: 'aiCustomization.runPrompt', title: 'Run' },
    when: ContextKeyExpr.and(
        ContextKeyExpr.equals('activeEditor', 'aiCustomization.editor'),
        ChatContextKeys.enabled
    ),
});
```

---

## Data Flow

```
┌──────────────┐    parse     ┌───────────────┐    render    ┌────────────┐
│ .agent.md    │ ──────────▶  │ Parsed Model  │ ──────────▶  │ Form UI    │
│ (file)       │              │ (frontmatter  │              │            │
└──────────────┘              │  + body AST)  │              └────────────┘
       ▲                      └───────────────┘                    │
       │                             │                             │
       │    serialize                │ validate                    │ user edit
       │                             ▼                             │
       │                      ┌───────────────┐                    │
       └───────────────────── │ Working Model │ ◀──────────────────┘
                              └───────────────┘
                                     │
                                     │ onDidChangeModel
                                     ▼
                              ┌───────────────┐
                              │ Preview Pane  │
                              └───────────────┘
```

---

## Validation

| Field | Validation |
|-------|------------|
| `name` | Required, unique within scope |
| `model` | Must match available language model IDs |
| `tools` | Must be registered tool IDs |
| `instructions` | Non-empty for agents |

Validation surfaces inline (like Settings) with severity chips and blocks save on errors.

---

## Next Steps

1. **Choose primary design**: Recommend Option 1 (Form + Preview) for v1 simplicity
2. **Scaffold files**: `aiCustomizationEditor.contribution.ts`, input, pane
3. **Build FormViewPane**: Map frontmatter schema to field renderers
4. **Wire IPromptsService**: Parse/serialize round-trip
5. **Add preview**: Embed mini chat widget for run/test
6. **Gate everything**: Ensure `ChatContextKeys.enabled` hides when AI disabled
7. **Test**: Unit tests for parser; integration tests for open/edit/save cycle

---

## References

- [Settings Editor](../src/vs/workbench/contrib/preferences/browser/settingsEditor2.ts)
- [Keybindings Editor](../src/vs/workbench/contrib/preferences/browser/keybindingsEditor.ts)
- [Webview Editor](../src/vs/workbench/contrib/webviewPanel/browser/webviewEditorInput.ts)
- [Custom Editor Registration](../src/vs/workbench/services/editor/browser/editorResolverService.ts)
- [AI Customization View](../src/vs/workbench/contrib/chat/browser/aiCustomization/)
- [IPromptsService](../src/vs/workbench/contrib/chat/common/promptSyntax/service/promptsService.ts)
