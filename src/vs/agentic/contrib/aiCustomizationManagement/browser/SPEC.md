# AI Customization Management Editor Specification

## Overview

The AI Customization Management Editor is a global management interface for all AI customizations in VS Code. It provides a unified view of agents, skills, instructions, and prompts across all storage locations (workspace, user, extensions) with filtering, searching, and bulk operations.

**Location:** `src/vs/workbench/contrib/chat/browser/aiCustomizationManagement/`

**Purpose:** Provide a centralized, searchable view of all AI customizations in the current workspace and user profile, making it easy to discover, manage, and organize these files.

**Key Differentiator:** Unlike the tree view (hierarchical) or editor (single-file), this is a flat, searchable list view optimized for bulk operations and discovery.

## Architecture

### Component Hierarchy

```
AICustomizationManagementEditor (EditorPane)
├── Header
│   ├── Title
│   └── New Button (with dropdown)
├── SplitView (Horizontal orientation)
│   ├── Sidebar Panel (Left side)
│   │   └── WorkbenchList (Section navigator)
│   │       ├── Agents
│   │       ├── Skills
│   │       ├── Instructions
│   │       └── Prompts
│   └── Content Panel (Right side)
│       ├── Search Box (top)
│       └── AICustomizationListWidget
│           └── WorkbenchList (Item list)
│               └── Item Renderer (icon, name, description, badge)
```

### File Structure

```
aiCustomizationManagement/
├── aiCustomizationManagement.ts              # Constants, IDs, enums
├── aiCustomizationManagement.contribution.ts # Registration and actions
├── aiCustomizationManagementEditor.ts        # Main editor pane
├── aiCustomizationManagementEditorInput.ts   # Singleton editor input
├── aiCustomizationListWidget.ts              # List widget component
└── media/
    └── aiCustomizationManagement.css         # Styling
```

## Key Components

### AICustomizationManagementEditorInput

**Extends:** `EditorInput`

**Pattern:** **Singleton** - Only one instance exists globally

**Responsibilities:**
- Represents the management editor as a singleton input
- Ensures only one management editor can be open at a time
- Provides factory method `getOrCreate()` for access

**Key Features:**
- `static getOrCreate()` - Returns singleton instance
- `getName()` - Returns "AI Customizations" for tab title
- `matches()` - Compares by singleton identity
- `canDispose()` - Returns false to prevent disposal

**Serialization:**
- Serializes to empty string (stateless)
- Deserializes to singleton instance
- Workspace restoration works automatically

### AICustomizationManagementEditor

**Extends:** `EditorPane`

**Responsibilities:**
- Renders split-pane management interface
- Manages section navigation sidebar
- Coordinates search and filtering
- Handles context menus and actions
- Persists UI state (selected section, sidebar width, search query)

**Key Features:**

**Sidebar Navigation:**
- Four sections: Agents, Skills, Instructions, Prompts
- Shows count badge for each section
- Click to switch active section
- Persisted selection across sessions

**Search & Filtering:**
- Real-time fuzzy search across names and descriptions
- Debounced input (300ms) for performance
- Highlights matches in results
- Persisted search query
- Clears automatically on section change

**Responsive Layout:**
- Resizable sidebar (min 150px, max 350px, default 200px)
- Sash border for split view
- Content panel minimum width 400px
- Persists sidebar width to storage

**Context Integration:**
- Sets `CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_EDITOR` when focused
- Sets `CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_SECTION` to current section
- Enables context-aware commands and keybindings

**State Persistence:**
- Selected section → `AI_CUSTOMIZATION_MANAGEMENT_SELECTED_SECTION_KEY`
- Sidebar width → `AI_CUSTOMIZATION_MANAGEMENT_SIDEBAR_WIDTH_KEY`
- Search query → `AI_CUSTOMIZATION_MANAGEMENT_SEARCH_KEY`
- All persisted to `StorageScope.PROFILE, StorageTarget.USER`

### AICustomizationListWidget

**Extends:** `Disposable`

**Responsibilities:**
- Renders searchable list of AI customization items
- Handles search box and filtering logic
- Manages list selection and activation
- Coordinates with IPromptsService for data

**Key Features:**

**Data Loading:**
- Loads items for specific section (agents/skills/instructions/prompts)
- Queries all storage locations (workspace, user, extensions)
- Special handling for skills (parses frontmatter for names)
- Debounced reload on service change events

**Search Implementation:**
- Fuzzy matching using `matchesFuzzy()` from base
- Searches both name and description fields
- Stores match highlights for rendering
- Empty search shows all items
- Debounced input for performance (300ms)

**List Rendering:**
- Virtual scrolling for performance
- Fixed item height (32px)
- Icon based on prompt type
- Storage badge (workspace/user/extension)
- Highlighted labels show search matches
- Hover tooltips for full text

**Item Activation:**
- Double-click to open in AI Customization Editor
- Context menu with actions (Open, Open as Text, Run, etc.)
- Keyboard navigation (Enter to open)
- Selection persistence

**Events:**
- `onDidChangeItems` - Fired when item list changes
- `onDidChangeSelection` - Fired when selection changes
- `onDidOpen` - Fired when item opened

### Section List (Sidebar)

**Component:** `WorkbenchList<ISectionItem>`

**Item Structure:**
```typescript
interface ISectionItem {
  readonly id: AICustomizationManagementSection;
  readonly label: string;
  readonly icon: ThemeIcon;
  count?: number;  // Badge count
}
```

**Sections:**
1. **Agents** - Custom agents (`.agent.md`)
2. **Skills** - Skills (`SKILL.md`)
3. **Instructions** - Instructions (`.instructions.md`)
4. **Prompts** - Prompts (`.prompt.md`)

**Rendering:**
- Icon + label + count badge
- Selection highlights active section
- Updates counts when content changes

### Item List (Content)

**Component:** `WorkbenchList<IAICustomizationListItem>`

**Item Structure:**
```typescript
interface IAICustomizationListItem {
  readonly id: string;           // Unique ID
  readonly uri: URI;             // File URI
  readonly name: string;         // Display name
  readonly description?: string; // Optional description
  readonly storage: PromptsStorage;  // workspace/user/extension
  readonly promptType: PromptsType;  // agent/skill/instructions/prompt
  nameMatches?: IMatch[];        // Search highlights
  descriptionMatches?: IMatch[]; // Search highlights
}
```

**Rendering:**
- Left side: Icon + name + description (with highlights)
- Right side: Storage badge (workspace/user/extension icon)
- Hover shows full text
- Click to select, double-click to open
- Context menu on right-click

## Registration & Integration

### Editor Pane Registration

**Contribution Point:** `EditorExtensions.EditorPane`

```typescript
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
  EditorPaneDescriptor.create(
    AICustomizationManagementEditor,
    AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID,
    "AI Customizations Editor"
  ),
  [new SyncDescriptor(AICustomizationManagementEditorInput)]
);
```

### Serializer Registration

**Serializer:** `AICustomizationManagementEditorInputSerializer`

**Behavior:**
- Serializes to empty string (no state needed)
- Deserializes to singleton instance via `getOrCreate()`
- Ensures workspace restoration works correctly

### Action Registration

**Command:** `aiCustomization.openManagementEditor`

**Registration:**
```typescript
Action2({
  id: AICustomizationManagementCommands.OpenEditor,
  title: "Open AI Customizations",
  category: CHAT_CATEGORY,
  precondition: ChatContextKeys.enabled,
  f1: true
})
```

**Execution:**
- Gets singleton input via `AICustomizationManagementEditorInput.getOrCreate()`
- Opens in active group with `{ pinned: true }`
- If already open, brings to front

## Constants & IDs

### Editor Identifiers

```typescript
AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID = 'workbench.editor.aiCustomizationManagement'
AI_CUSTOMIZATION_MANAGEMENT_EDITOR_INPUT_ID = 'workbench.input.aiCustomizationManagement'
```

### Command IDs

```typescript
AICustomizationManagementCommands = {
  OpenEditor: 'aiCustomization.openManagementEditor',
  CreateNewAgent: 'aiCustomization.createNewAgent',
  CreateNewSkill: 'aiCustomization.createNewSkill',
  CreateNewInstructions: 'aiCustomization.createNewInstructions',
  CreateNewPrompt: 'aiCustomization.createNewPrompt',
}
```

### Section IDs

```typescript
AICustomizationManagementSection = {
  Agents: 'agents',
  Skills: 'skills',
  Instructions: 'instructions',
  Prompts: 'prompts',
}
```

### Context Keys

```typescript
CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_EDITOR        // Editor focused
CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_SECTION       // Current section
```

### Storage Keys

```typescript
AI_CUSTOMIZATION_MANAGEMENT_SELECTED_SECTION_KEY  // Last selected section
AI_CUSTOMIZATION_MANAGEMENT_SIDEBAR_WIDTH_KEY     // Sidebar width
AI_CUSTOMIZATION_MANAGEMENT_SEARCH_KEY            // Search query
```

All persisted to: `StorageScope.PROFILE, StorageTarget.USER`

### Layout Constants

```typescript
SIDEBAR_DEFAULT_WIDTH = 200  // Default sidebar width
SIDEBAR_MIN_WIDTH = 150      // Minimum sidebar width
SIDEBAR_MAX_WIDTH = 350      // Maximum sidebar width
CONTENT_MIN_WIDTH = 400      // Minimum content width
```

### Menu IDs

```typescript
AICustomizationManagementTitleMenuId  // Title bar actions
AICustomizationManagementItemMenuId   // Item context menu
```

## User Workflows

### Opening the Management Editor

**Via Command Palette:**
1. User opens command palette (Cmd+Shift+P)
2. Types "Open AI Customizations"
3. Editor opens in active group

**Via Keybinding:**
1. (Future) Keybinding assigned to command
2. Editor opens directly

**Singleton Behavior:**
- If already open, editor is brought to front
- Only one instance can exist
- Tab shows "AI Customizations" title

### Browsing Sections

1. User clicks "Skills" in sidebar
2. Search box clears automatically
3. Content area loads all skills
4. Count badge updates
5. Selection persisted for next open

### Searching Items

1. User types "http" in search box
2. After 300ms debounce, search executes
3. List filters to matching items
4. Matches highlighted in name and description
5. Clear button (X) to reset search
6. Search query persisted across sections

### Opening an Item

**Double-Click:**
1. User double-clicks item in list
2. File opens in AI Customization Editor
3. Management editor remains open

**Context Menu:**
1. User right-clicks item
2. Context menu appears with actions:
   - Open (in AI Customization Editor)
   - Open as Text (in standard editor)
   - Run Prompt (for prompts only)
   - Delete (future)
   - Rename (future)
3. User selects action
4. Action executes

### Creating New Items

1. User clicks "New" button in header
2. Dropdown shows: Agent, Skill, Instructions, Prompt
3. User selects type
4. Prompt file picker appears
5. User chooses location and name
6. New file created and opened
7. Management editor refreshes

### Resizing Sidebar

1. User drags sash between sidebar and content
2. Sidebar resizes (constrained to min/max)
3. Content area adjusts accordingly
4. New width persisted to storage
5. Width restored on next open

## Search Algorithm

### Fuzzy Matching

**Implementation:** Uses `matchesFuzzy()` from base

**Matching Strategy:**
1. Normalize query and target strings (lowercase)
2. Find all characters of query in target (in order)
3. Score based on:
   - Contiguous matches (higher score)
   - Case matches (higher score)
   - Position (earlier = higher score)
4. Return match ranges for highlighting

**Fields Searched:**
- Item name (primary)
- Item description (secondary)

**Highlighting:**
- Matched characters highlighted in bold
- Uses `HighlightedLabel` component
- Separate highlights for name and description

### Performance Optimization

**Debouncing:**
- Search input debounced to 300ms
- Prevents excessive re-filtering
- Cancels pending searches

**Lazy Rendering:**
- List uses virtual scrolling
- Only visible items rendered
- Fast scrolling performance

**Caching:**
- Match results cached per query
- Cleared on data change
- Reused on re-render

## Styling

**CSS File:** `media/aiCustomizationManagement.css`

**Key Classes:**

```css
.ai-customization-management-editor   /* Main container */
.management-header                    /* Top header area */
.management-title                     /* "AI Customizations" title */
.management-new-button                /* New item button */
.management-splitview                 /* SplitView container */
.management-sidebar                   /* Left sidebar panel */
.section-list-item                    /* Sidebar section item */
.section-icon                         /* Section icon */
.section-label                        /* Section label */
.section-count                        /* Count badge */
.management-content                   /* Right content panel */
.ai-customization-list-item           /* List item */
.item-left                            /* Left side (icon + text) */
.item-icon                            /* Item icon */
.item-name                            /* Item name (highlighted) */
.item-description                     /* Item description (highlighted) */
.item-right                           /* Right side (badge) */
.storage-badge                        /* Storage location badge */
```

**Color Tokens:**

```typescript
aiCustomizationManagementSashBorder   // Sash border color
```

## AI Feature Gating

**Requirement:** Editor must be hidden when AI features disabled

**Implementation:**
- Command precondition: `ChatContextKeys.enabled`
- Editor not accessible when `chat.disableAIFeatures = true`
- Command hidden from Command Palette when disabled
- Consistent with other AI features

## Integration Points

### IPromptsService

**Methods Used:**
- `listPromptFilesForStorage(type, storage)` - Get files by type/storage
- `findAgentSkills()` - Get skills with parsed names
- `onDidChangeCustomAgents` - Reload on agent changes
- `onDidChangeSlashCommands` - Reload on command changes

**Data Flow:**
1. Service maintains canonical list of files
2. Editor subscribes to change events
3. On change, reloads current section
4. Updates counts for all sections

### IEditorService

**Used For:**
- Opening files in AI Customization Editor
- Opening files in text editor
- Managing editor inputs
- Editor group coordination

### IOpenerService

**Used For:**
- Opening file URIs
- Handling external links
- Protocol handling

### IContextMenuService

**Used For:**
- Showing item context menus
- Positioning menus
- Handling selection

### IStorageService

**Used For:**
- Persisting selected section
- Persisting sidebar width
- Persisting search query
- Profile-scoped storage

### IContextKeyService

**Used For:**
- Setting editor focused context key
- Setting section context key
- Enabling context-aware actions

## Performance Considerations

### Virtual Scrolling

- List renders only visible items
- Handles thousands of items efficiently
- Smooth scrolling performance

### Debouncing

- Search input debounced (300ms)
- Section switches cancel pending operations
- Data reload throttled

### Memory Management

- Disposables properly cleaned up
- Event listeners unregistered
- Renderers disposed on hide

### Data Loading

- Lazy loading per section
- Not all sections loaded at once
- Cached results until data changes

## Error Handling

### No Items Found

- Shows empty state message
- Suggests creating new items
- Provides quick action buttons

### Service Errors

- Gracefully handles IPromptsService errors
- Shows error notification
- Allows retry

### File Access Errors

- Handles missing files
- Shows error when opening fails
- Suggests removing invalid items

## Testing Considerations

### Unit Tests

- Singleton pattern correctness
- Search/filter logic
- Section switching
- State persistence
- Context key management

### Integration Tests

- End-to-end opening workflow
- Search with highlighting
- Context menu actions
- New item creation
- Serialization/restoration

## Future Enhancements

### Potential Features

- **Bulk Operations:** Select multiple, delete, move
- **Sorting:** Sort by name, date, storage
- **Filtering:** Filter by storage location
- **Grouping:** Group by storage or type
- **Details Pane:** Show item details in side panel
- **Drag & Drop:** Reorganize or move items
- **Import/Export:** Bulk import/export
- **Tags:** Tag items for organization
- **Favorites:** Pin frequently used items

### Architecture Extensions

- Grid view option (in addition to list)
- Custom views via contributions
- Advanced search (regex, filters)
- Command palette integration

## Related Components

- **AI Customization Tree View:** Hierarchical sidebar view
- **AI Customization Editor:** Single-file form editor
- **Prompts Service:** Core data service
- **Prompt File Pickers:** Creation wizards
- **Chat Integration:** Uses managed files

---

*This specification documents the AI Customization Management Editor as implemented in `src/vs/workbench/contrib/chat/browser/aiCustomizationManagement/`*
