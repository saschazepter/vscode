# AI Customization Editor Specification

## Overview

The AI Customization Editor is a form-based, structured editor for AI customization files (`.agent.md`, `.skill.md`, `.instructions.md`, `.prompt.md`). It provides a split-pane interface with a table-of-contents (TOC) sidebar for navigation and a main content area with field-based editing.

**Location:** `src/vs/workbench/contrib/chat/browser/aiCustomizationEditor/`

**Purpose:** Provide a user-friendly, structured editing experience for AI customization files, abstracting away the underlying markdown format and presenting fields in an organized, section-based layout.

**Alternative to:** Standard text editor (users can still open files as text via "Open as Text" command)

## Architecture

### Component Hierarchy

```
AICustomizationEditorPane (EditorPane)
├── SplitView (Horizontal orientation)
│   ├── TOC Panel (Left side)
│   │   └── WorkbenchAsyncDataTree
│   │       ├── TocDataSource
│   │       ├── TocTreeDelegate
│   │       └── TocSectionRenderer
│   └── Editor Panel (Right side)
│       ├── Action Bar (top)
│       ├── DomScrollableElement (scrollable content)
│       │   └── SectionRenderers (dynamically created)
│       │       └── Field Renderers (per field)
│       │           ├── TextFieldRenderer
│       │           ├── MultilineFieldRenderer
│       │           ├── ArrayFieldRenderer
│       │           ├── CheckboxFieldRenderer
│       │           └── ReadonlyFieldRenderer
│       └── Save/Discard buttons (bottom)
```

### File Structure

```
aiCustomizationEditor/
├── aiCustomizationEditor.ts              # Constants, IDs, MenuIds
├── aiCustomizationEditor.contribution.ts # Registration and serialization
├── input/
│   └── aiCustomizationEditorInput.ts     # EditorInput and model
├── pane/
│   └── aiCustomizationEditorPane.ts      # Main editor pane implementation
├── fields/
│   └── fieldRenderers.ts                 # Field rendering infrastructure
└── media/
    └── aiCustomizationEditor.css         # Styling
```

## Key Components

### AICustomizationEditorInput

**Extends:** `EditorInput`

**Responsibilities:**
- Represents an opened AI customization file in the editor
- Manages the file resource URI
- Provides editor capabilities and metadata
- Resolves to `AICustomizationEditorModel` on open

**Key Methods:**
- `resolve()` - Creates/returns `AICustomizationEditorModel`
- `getName()` - Returns file name for editor tab
- `matches()` - Compares with other inputs

### AICustomizationEditorModel

**Extends:** `EditorModel`

**Responsibilities:**
- Loads and parses AI customization file content
- Maintains in-memory representation of frontmatter fields
- Tracks dirty state (unsaved changes)
- Saves changes back to file system

**Key Properties:**
- `resource: URI` - File URI
- `frontmatter: PromptHeaderAttributes` - Parsed frontmatter fields
- `content: string` - Full file content

**Key Methods:**
- `load()` - Reads file from disk and parses frontmatter
- `save()` - Writes modified frontmatter back to file
- `updateField(key, value)` - Updates a field value
- `isDirty()` - Returns whether there are unsaved changes

### AICustomizationEditorPane

**Extends:** `EditorPane`

**Responsibilities:**
- Renders the split-pane editor UI
- Manages TOC tree and section navigation
- Creates and updates field renderers
- Handles save/discard actions
- Persists TOC width and layout state

**Key Features:**

**Responsive Layout:**
- TOC panel resizable via sash (min: 140px, default: 220px)
- Narrow mode (<660px width) hides TOC automatically
- Editor panel has minimum width of 400px
- Persists TOC width to storage

**TOC Navigation:**
- Hierarchical tree showing sections for current file type
- Sections differ by prompt type (agent vs skill vs instructions vs prompt)
- Click to scroll to section in editor
- Auto-expands sections on load

**Section-Based Editing:**
- Content organized into logical sections (Overview, Behavior, Tools, etc.)
- Each section contains related fields
- Sections loaded dynamically based on file type

**Field Editing:**
- Each field rendered with appropriate control (text, multiline, checkbox, array)
- Required fields marked with asterisk
- Field changes tracked for dirty state
- Validation on save

**Auto-Save Support:**
- Integrates with VS Code auto-save
- Dirty indicator in tab
- Save/discard buttons in footer

### Field Renderers

**Base Class:** `BaseFieldRenderer`

All field renderers extend this base and implement:
- `render(container)` - Creates DOM elements
- `setValue(value)` - Updates displayed value
- `getValue()` - Returns current value
- `focus()` - Sets focus to input
- `onDidChange` - Event fired when value changes

**Field Types:**

| Renderer | Type | Use Case | Control |
|----------|------|----------|---------|
| `TextFieldRenderer` | `text` | Single-line strings (name, description) | `InputBox` |
| `MultilineFieldRenderer` | `multiline` | Multi-line text (instructions, prompts) | `textarea` |
| `ArrayFieldRenderer` | `array` | String arrays (model, tools, capabilities) | Multiple `InputBox` with add/remove |
| `CheckboxFieldRenderer` | `checkbox` | Boolean flags (enabled, hidden) | `Toggle` |
| `ReadonlyFieldRenderer` | `readonly` | Non-editable fields (file path) | Plain text |

### Section Definitions

**ISectionDefinition:**
```typescript
interface ISectionDefinition {
  readonly id: string;           // Unique section ID
  readonly label: string;        // Display name
  readonly icon: ThemeIcon;      // Section icon
  readonly fields: IFieldDefinition[];  // Fields in this section
  readonly description?: string; // Optional description
}
```

**IFieldDefinition:**
```typescript
interface IFieldDefinition {
  readonly id: string;           // Unique field ID
  readonly key: string;          // Frontmatter key
  readonly label: string;        // Display label
  readonly description?: string; // Help text
  readonly type: 'text' | 'multiline' | 'array' | 'checkbox' | 'readonly';
  readonly placeholder?: string; // Placeholder text
  readonly required?: boolean;   // Validation flag
}
```

**Section Layout by Type:**

**Agent Files (`.agent.md`):**
1. Overview - name, description, file path
2. Behavior - model, instructions, capabilities
3. Tools - tools array, custom tools
4. Advanced - hidden flag, custom settings

**Skill Files (`SKILL.md`):**
1. Overview - name, description, file path
2. Instructions - skill-specific instructions
3. Advanced - metadata, custom settings

**Instructions Files (`.instructions.md`):**
1. Overview - name, description, file path, apply pattern
2. Content - instructions text
3. Advanced - metadata

**Prompt Files (`.prompt.md`):**
1. Overview - name, description, file path
2. Content - prompt text
3. Advanced - metadata

## Registration & Integration

### Editor Registration

**Contribution Point:** `EditorExtensions.EditorPane`

**Registration:**
```typescript
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
  EditorPaneDescriptor.create(
    AICustomizationEditorPane,
    AI_CUSTOMIZATION_EDITOR_ID,
    "AI Customization Editor"
  ),
  [new SyncDescriptor(AICustomizationEditorInput)]
);
```

### Editor Resolver

**File Patterns:**
- `**/*.prompt.md`
- `**/*.agent.md`
- `**/*.instructions.md`
- `**/SKILL.md`

**Registration:**
```typescript
editorResolverService.registerEditor(
  pattern,
  {
    id: AI_CUSTOMIZATION_EDITOR_VIEW_TYPE,
    label: "AI Customization Editor",
    priority: RegisteredEditorPriority.option  // Available but not default
  },
  {
    canSupportResource: () => chatEnabled.get()  // Only when chat enabled
  }
);
```

**Behavior:**
- Available as an editor option, not the default
- Users can right-click file → "Open With..." → "AI Customization Editor"
- Or set as default for these file types in settings
- Only available when `chat.disableAIFeatures` is false

### Serialization

**Serializer:** `AICustomizationEditorInputSerializer`

**Purpose:** Restore editor state on workspace reload

**Serialized Data:**
```json
{
  "resource": "file:///path/to/file.agent.md"
}
```

## Constants & IDs

### Editor Identifiers

```typescript
AI_CUSTOMIZATION_EDITOR_ID = 'workbench.editor.aiCustomizationEditor'
AI_CUSTOMIZATION_EDITOR_VIEW_TYPE = 'aiCustomization.editor'
```

### Layout Constants

```typescript
TOC_MIN_WIDTH = 140          // Minimum TOC panel width
TOC_DEFAULT_WIDTH = 220      // Default TOC panel width
EDITOR_MIN_WIDTH = 400       // Minimum editor panel width
NARROW_THRESHOLD = 660       // Width below which TOC hides
```

### Storage Keys

```typescript
AI_CUSTOMIZATION_EDITOR_TOC_WIDTH_KEY = 'aiCustomizationEditor.tocWidth'
```

Persisted to: `StorageScope.PROFILE, StorageTarget.USER`

### Menu IDs

```typescript
AICustomizationEditorTitleMenuId    // Editor title bar actions
AICustomizationEditorFieldMenuId    // Field context menu
```

## User Workflows

### Opening a File

1. User navigates to `.agent.md` file in explorer
2. User right-clicks → "Open With..." → "AI Customization Editor"
3. `AICustomizationEditorInput` created with file URI
4. `AICustomizationEditorPane.setInput()` called
5. Model resolves: loads file, parses frontmatter
6. TOC tree populated based on file type
7. Sections and fields rendered
8. Editor ready for editing

### Editing Fields

1. User clicks into a field (text, multiline, checkbox, etc.)
2. Field renderer captures input
3. `onDidChange` event fires
4. Model marks itself dirty
5. Editor tab shows dirty indicator (dot)
6. Save button becomes enabled

### Saving Changes

1. User clicks "Save" button or triggers save action (Cmd+S)
2. Editor collects all field values
3. Model validates required fields
4. Model updates frontmatter
5. Model writes to file system
6. Dirty state cleared
7. Editor tab dirty indicator removed

### Navigating with TOC

1. User clicks section in TOC tree
2. Editor panel scrolls to corresponding section
3. TOC selection updates
4. Section becomes visible in viewport

### Resizing TOC

1. User drags sash between TOC and editor
2. Split view updates panel sizes
3. New TOC width persisted to storage
4. Width restored on next open

## Styling

**CSS File:** `media/aiCustomizationEditor.css`

**Key Selectors:**

```css
.ai-customization-editor-pane        /* Main container */
.ai-customization-toc-container      /* TOC panel */
.ai-customization-toc-section        /* TOC section item */
.ai-customization-editor-content     /* Editor scroll container */
.ai-customization-section            /* Section container */
.ai-customization-section-header     /* Section title with icon */
.ai-customization-field-item         /* Individual field */
.field-label                         /* Field label */
.field-description                   /* Field help text */
.field-control                       /* Field input control */
.ai-customization-action-bar         /* Top action bar */
.ai-customization-footer             /* Bottom button bar */
```

**Layout Patterns:**

- Flexbox for TOC items
- Grid for section layouts
- Ellipsis overflow for long labels
- Sticky section headers on scroll
- Minimum widths to prevent collapse

## AI Feature Gating

**Requirement:** Editor must respect `chat.disableAIFeatures` setting

**Implementation:**
- Editor resolver checks `ChatContextKeys.enabled`
- Only registers when chat is enabled
- Returns `canSupportResource: false` when AI disabled
- Editor not available in "Open With" menu when disabled

**Context Key:**
```typescript
when: ChatContextKeys.enabled
```

## Integration Points

### IPromptsService

**Methods Used:**
- `readPromptFile(uri)` - Load file content
- `writePromptFile(uri, content)` - Save file content
- `parsePromptFile(content)` - Parse frontmatter

### IEditorService

**Used For:**
- Opening files in editor groups
- Checking if file is already open
- Managing editor input lifecycle

### IFileService

**Used For:**
- Reading file content from disk
- Writing modified content back
- Watching for external file changes
- Checking file existence

### ITextFileService

**Used For:**
- Integration with auto-save
- Dirty state tracking
- Revert functionality

### IContextViewService

**Used For:**
- Rendering dropdown menus for array fields
- Showing context menus for fields
- Input box suggestions

### IHoverService

**Used For:**
- Tooltips on field labels
- Help text on hover
- Validation error messages

## Performance Considerations

### Lazy Rendering

- Sections rendered on-demand as user scrolls
- Field renderers created only when section visible
- TOC tree uses virtual scrolling for large lists

### Debouncing

- Field changes debounced (300ms) before updating model
- Save operation throttled to prevent rapid saves
- Scroll events debounced for TOC sync

### Memory Management

- All renderers properly disposed on section hide
- Event listeners cleaned up on dispose
- Model cached per resource (singleton pattern)

### Large Files

- Multiline fields use efficient text rendering
- Array fields virtualized for long lists
- Content scrolling optimized for smooth experience

## Error Handling

### File Not Found

- Show error message in editor
- Offer to create file
- Disable editing until file exists

### Parse Errors

- Show warning banner
- Fall back to text editor
- Highlight problematic frontmatter

### Save Errors

- Show error notification
- Keep dirty state
- Retry mechanism

### Validation Errors

- Highlight invalid fields
- Show inline error messages
- Prevent save until resolved

## Testing Considerations

### Unit Tests

- Field renderer behavior (setValue/getValue)
- Model frontmatter parsing
- TOC data source population
- Section definition correctness

### Integration Tests

- End-to-end file opening
- Save/discard workflows
- Editor resolution for file types
- Serialization/deserialization

### Manual Testing

- Responsive layout at various widths
- Narrow mode TOC hiding
- Sash resizing and persistence
- Field type rendering
- Save/revert scenarios

## Future Enhancements

### Potential Features

- **Live Preview:** Show markdown preview alongside editor
- **Validation:** Real-time validation of field values
- **Code Completion:** Suggest values for model, tools fields
- **Templates:** Quick-start templates for new files
- **Diff View:** Compare changes before saving
- **Collaboration:** Multi-user editing support
- **History:** View and restore previous versions
- **Import/Export:** Bulk operations on files

### Architecture Extensions

- Plugin system for custom field types
- Extensible section definitions via contributions
- Theme customization for editor appearance
- Accessibility improvements (screen reader support)

## Related Components

- **AI Customization Tree View:** Lists these files in sidebar
- **AI Customization Management:** Global management view
- **Prompt File Parser:** Parses frontmatter and content
- **Prompts Service:** Core service for file operations
- **Chat Integration:** Uses these files for agent behavior

---

*This specification documents the AI Customization Editor as implemented in `src/vs/workbench/contrib/chat/browser/aiCustomizationEditor/`*
