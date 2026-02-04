# AI Customization Tree View Specification

## Overview

The AI Customization Tree View is a hierarchical tree view displayed in the VS Code sidebar that organizes AI customization files (agents, skills, instructions, prompts) by type and storage location. It provides quick access to these files and actions for creating, opening, and running them.

**Location:** `src/vs/workbench/contrib/chat/browser/aiCustomizationTreeView/`

**Purpose:** Provide a navigable, hierarchical view of all AI customizations in the workspace, making it easy to browse and access files organized by category and storage location.

**Key Differentiator:** Unlike the management editor (flat list) or editor (single-file), this provides a structured tree hierarchy optimized for quick navigation and workspace awareness.

## Architecture

### Component Hierarchy

```
View Container (Sidebar)
└── AI Customization View
    └── AICustomizationViewPane (ViewPane)
        └── WorkbenchAsyncDataTree
            ├── UnifiedAICustomizationDataSource
            ├── AICustomizationTreeDelegate
            └── Renderers (3 types)
                ├── AICustomizationCategoryRenderer
                ├── AICustomizationGroupRenderer
                └── AICustomizationFileRenderer
```

### Tree Structure

```
ROOT (Symbol)
├── Custom Agents (category)
│   ├── Workspace (group)
│   │   ├── python-expert.agent.md (file)
│   │   └── web-dev.agent.md (file)
│   ├── User (group)
│   │   └── my-agent.agent.md (file)
│   └── Extensions (group)
│       └── github-copilot.agent.md (file)
├── Skills (category)
│   ├── Workspace (group)
│   │   └── html-app/SKILL.md (file)
│   └── User (group)
│       └── ios-setup/SKILL.md (file)
├── Instructions (category)
│   ├── Workspace (group)
│   │   └── ai-customization.instructions.md (file)
│   └── User (group)
│       └── my-style.instructions.md (file)
└── Prompts (category)
    ├── Workspace (group)
    │   └── my-prompt.prompt.md (file)
    └── User (group)
        └── greeting.prompt.md (file)
```

### File Structure

```
aiCustomizationTreeView/
├── aiCustomizationTreeView.ts              # Constants, IDs, MenuIds
├── aiCustomizationTreeView.contribution.ts # View/action registration
├── aiCustomizationTreeViewViews.ts         # Tree implementation
├── aiCustomizationTreeViewIcons.ts         # Icon registrations
└── media/
    └── aiCustomizationTreeView.css         # Styling
```

## Key Components

### View Container

**ID:** `AI_CUSTOMIZATION_VIEWLET_ID = 'workbench.view.aiCustomization'`

**Type:** `ViewPaneContainer` with `mergeViewWithContainerWhenSingleView: true`

**Configuration:**
- **Title:** "AI Customization"
- **Icon:** `aiCustomizationViewIcon` (sparkle)
- **Location:** Sidebar
- **Order:** 10
- **Keybinding:** `Cmd+Shift+I`

**Behavior:**
- Merges with single view inside (no redundant headers)
- Collapsible and closable
- Persists state to `AI_CUSTOMIZATION_STORAGE_ID`
- Hidden when AI features disabled

### Tree View

**ID:** `AI_CUSTOMIZATION_VIEW_ID = 'aiCustomization.view'`

**Type:** `AICustomizationViewPane` (extends `ViewPane`)

**Configuration:**
- **Name:** "AI Customization"
- **Toggleable:** Yes
- **Moveable:** Yes
- **When:** `ChatContextKeys.enabled`

**Features:**
- Single unified tree showing all types
- Auto-expands categories on load
- Context menus on items
- Refresh and collapse actions
- Welcome content when empty

### AICustomizationViewPane

**Extends:** `ViewPane`

**Responsibilities:**
- Creates and manages WorkbenchAsyncDataTree
- Subscribes to IPromptsService change events
- Handles item opening (double-click)
- Shows context menus
- Provides public API for actions (refresh, collapse, expand)

**Key Features:**

**Initialization:**
1. Subscribe to service events:
   - `onDidChangeCustomAgents`
   - `onDidChangeSlashCommands`
2. Create WorkbenchAsyncDataTree with:
   - Three renderers (category, group, file)
   - Data source (`UnifiedAICustomizationDataSource`)
   - Delegate for sizing
3. Register event handlers:
   - `onDidOpen` → open file in editor
   - `onContextMenu` → show context menu
4. Set tree input to `ROOT_ELEMENT`
5. Auto-expand categories to reveal groups

**Auto-Expansion:**
- After setting input, immediately expand root children
- Reveals storage groups (Workspace, User, Extensions) without user action
- Applied on both initial load and refresh
- Improves discoverability

**Event Handling:**
- Service changes trigger full refresh
- Preserves expansion state where possible
- Updates tree asynchronously

**Public API:**
```typescript
refresh(): Promise<void>      // Reload tree and re-expand
collapseAll(): void           // Collapse all nodes
expandAll(): Promise<void>    // Expand all nodes (future)
```

### Tree Item Types

**Discriminated Union:** `AICustomizationTreeItem`

All items have a `type` field for type discrimination.

#### 1. Root Element

**Type:** `Symbol` (ROOT_ELEMENT)

**Purpose:** Type-safe marker for tree root

**Usage:**
- Single instance created as `const ROOT_ELEMENT = Symbol('root')`
- Passed to tree as input
- Data source returns categories as children

#### 2. Category Item (IAICustomizationTypeItem)

**Type:** `'category'`

**Represents:** Top-level type categories

**Properties:**
```typescript
{
  type: 'category',
  id: string,              // 'agents' | 'skills' | 'instructions' | 'prompts'
  label: string,           // "Custom Agents" | "Skills" | etc.
  promptType: PromptsType, // agent | skill | instructions | prompt
  icon: ThemeIcon          // agentIcon | skillIcon | etc.
}
```

**Children:** Group items (Workspace, User, Extensions) that have files

**Rendering:**
- Bold label
- Icon from promptType
- Always shown (even if empty)

#### 3. Group Item (IAICustomizationGroupItem)

**Type:** `'group'`

**Represents:** Storage location headers

**Properties:**
```typescript
{
  type: 'group',
  id: string,                  // 'workspace' | 'user' | 'extensions'
  label: string,               // "WORKSPACE" | "USER" | "EXTENSIONS"
  storage: PromptsStorage,     // local | user | extension
  promptType: PromptsType,     // agent | skill | instructions | prompt
  icon: ThemeIcon              // workspaceIcon | userIcon | extensionIcon
}
```

**Children:** File items from that storage location

**Rendering:**
- Uppercase label
- Small font (11px)
- Letter-spacing
- `descriptionForeground` color
- No icon displayed

**Visibility:**
- Only shown if storage location has files
- Empty groups automatically hidden

#### 4. File Item (IAICustomizationFileItem)

**Type:** `'file'`

**Represents:** Individual AI customization files

**Properties:**
```typescript
{
  type: 'file',
  id: string,              // Unique ID (URI string)
  uri: URI,                // File URI
  name: string,            // Display name
  description?: string,    // Optional description (for skills)
  storage: PromptsStorage, // local | user | extension
  promptType: PromptsType  // agent | skill | instructions | prompt
}
```

**Children:** None (leaf node)

**Rendering:**
- Icon based on promptType
- File name as label
- Tooltip with full path
- Context menu on right-click

**Special Handling for Skills:**
- Name from frontmatter `name` field (not filename)
- Uses `findAgentSkills()` service method
- Falls back to folder name if no frontmatter

### UnifiedAICustomizationDataSource

**Implements:** `IAsyncDataSource<RootElement | AICustomizationTreeItem, AICustomizationTreeItem>`

**Responsibilities:**
- Provides hierarchical data for tree
- Queries IPromptsService for files
- Filters out empty groups
- Handles skill name parsing

**Key Methods:**

#### hasChildren()

```typescript
hasChildren(element): boolean
```

Returns true for:
- ROOT_ELEMENT
- Category items
- Group items (always, filtered in getChildren)

Returns false for:
- File items (leaf nodes)

#### getChildren()

```typescript
async getChildren(element): Promise<AICustomizationTreeItem[]>
```

**Logic:**

**ROOT → Categories:**
```typescript
return [
  { type: 'category', promptType: PromptsType.agent, label: "Custom Agents", ... },
  { type: 'category', promptType: PromptsType.skill, label: "Skills", ... },
  { type: 'category', promptType: PromptsType.instructions, label: "Instructions", ... },
  { type: 'category', promptType: PromptsType.prompt, label: "Prompts", ... },
];
```

**Category → Groups (with files):**
1. Try each storage location (workspace, user, extensions)
2. Call `getGroupChildren()` for each
3. Filter to groups with files
4. Return non-empty groups

**Group → Files:**
- For skills: Call `findAgentSkills()` and filter by storage
- For others: Call `listPromptFilesForStorage(type, storage)`
- Map to file items with URI, name, description
- Sort by name

### Tree Renderers

Three specialized renderers for the three item types.

#### AICustomizationCategoryRenderer

**Template ID:** `'category'`

**Template:**
```html
<div class="ai-customization-category">
  <div class="icon"></div>
  <div class="label"></div>
</div>
```

**Rendering:**
- Icon from category's icon property
- Bold label
- Full-width layout

#### AICustomizationGroupRenderer

**Template ID:** `'group'`

**Template:**
```html
<div class="ai-customization-group-header">
  <div class="label"></div>
</div>
```

**Rendering:**
- Uppercase label
- Small, spaced letters
- Description foreground color
- No icon

#### AICustomizationFileRenderer

**Template ID:** `'file'`

**Template:**
```html
<div class="ai-customization-tree-item">
  <div class="icon"></div>
  <div class="name"></div>
</div>
```

**Rendering:**
- Icon based on promptType
- Name as label
- Ellipsis overflow
- Hover tooltip with URI

### Tree Delegate

**Class:** `AICustomizationTreeDelegate`

**Implements:** `IListVirtualDelegate<AICustomizationTreeItem>`

**Configuration:**
- All items: 22px height
- Template ID based on item type

## View Actions

### Toolbar Actions

**Location:** View title bar (MenuId.ViewTitle)

#### New Dropdown

**Type:** Submenu (AICustomizationNewMenuId)

**Icon:** Codicon.add

**Items:**
1. New Agent
2. New Skill
3. New Instructions
4. New Prompt

**Behavior:**
- Click opens submenu
- Each item opens `PromptFilePickers`
- User selects location and name
- File created and opened

#### Refresh

**ID:** `aiCustomization.refresh`

**Icon:** Codicon.refresh

**Action:** Calls `view.refresh()`

**Behavior:**
- Reloads all data from service
- Re-expands categories
- Preserves scroll position

#### Collapse All

**ID:** `aiCustomization.collapseAll`

**Icon:** Codicon.collapseAll

**Action:** Calls `view.collapseAll()`

**Behavior:**
- Collapses all expanded nodes
- Returns tree to initial state

### Context Menu Actions

**Menu ID:** `AICustomizationItemMenuId`

**When:** Item is a file (not category or group)

#### Open

**ID:** `aiCustomization.openFile`

**Title:** "Open"

**Icon:** Codicon.goToFile

**Action:** Opens file in AI Customization Editor

**Implementation:**
```typescript
editorService.openEditor({
  resource: uri,
  options: { override: AI_CUSTOMIZATION_EDITOR_ID }
});
```

#### Open as Text

**ID:** `aiCustomization.openAsText`

**Title:** "Open as Text"

**Icon:** Codicon.file

**Action:** Opens file in standard text editor

**Implementation:**
```typescript
editorService.openEditor({
  resource: uri,
  options: { override: 'default' }
});
```

#### Run Prompt

**ID:** `aiCustomization.runPrompt`

**Title:** "Run Prompt"

**Icon:** Codicon.play

**When:** `aiCustomizationItemType == 'prompt'`

**Action:** Runs prompt in chat

**Implementation:**
```typescript
commandService.executeCommand(
  'workbench.action.chat.run.prompt.current',
  uri
);
```

### Global Actions

#### Open AI Customization View

**ID:** `workbench.action.openAICustomizationView`

**Title:** "Open AI Customization View"

**Keybinding:** `Cmd+Shift+I`

**F1:** Yes

**Precondition:** `ChatContextKeys.enabled`

**Action:** Opens view container in sidebar

#### New Agent/Skill/Instructions/Prompt

**IDs:**
- `workbench.action.aiCustomization.newAgent`
- `workbench.action.aiCustomization.newSkill`
- `workbench.action.aiCustomization.newInstructions`
- `workbench.action.aiCustomization.newPrompt`

**Category:** "AI Customization"

**F1:** Yes

**Precondition:** `ChatContextKeys.enabled`

**Implementation:**
- Uses `PromptFilePickers.selectPromptFile()`
- Shows picker with `optionEdit: true`
- Creates file if new, opens if existing

## Context Keys

### AICustomizationIsEmptyContextKey

**Key:** `aiCustomization.isEmpty`

**Type:** `boolean`

**Purpose:** Shows welcome content when tree is empty

**When True:**
- No files found in any category
- Welcome view shown with create links

**When False:**
- At least one file exists
- Tree view shown

### AICustomizationItemTypeContextKey

**Key:** `aiCustomizationItemType`

**Type:** `string`

**Values:** `'agent' | 'skill' | 'instructions' | 'prompt' | ''`

**Purpose:** Enable type-specific context menu items

**Usage:**
- Set to item's promptType on context menu
- Used to show "Run Prompt" only for prompts
- Reset to empty when context menu closes

## Icons

**File:** `aiCustomizationTreeViewIcons.ts`

**Registered Icons:**

| Icon ID | Codicon | Usage |
|---------|---------|-------|
| `aiCustomizationViewIcon` | `sparkle` | View container icon |
| `agentIcon` | `copilot` | Agent files/categories |
| `skillIcon` | `lightbulb` | Skill files/categories |
| `instructionsIcon` | `book` | Instructions files/categories |
| `promptIcon` | `bookmark` | Prompt files/categories |
| `workspaceIcon` | `folder` | Workspace storage group |
| `userIcon` | `account` | User storage group |
| `extensionIcon` | `extensions` | Extensions storage group |

**Registration:**
```typescript
registerIcon(id, codicon, localize(description))
```

## Welcome Content

**When:** `AICustomizationIsEmptyContextKey == true`

**Content:**
```markdown
No AI customizations found.
[Create Agent](command:workbench.action.aiCustomization.newAgent)
[Create Skill](command:workbench.action.aiCustomization.newSkill)
[Create Instructions](command:workbench.action.aiCustomization.newInstructions)
[Create Prompt](command:workbench.action.aiCustomization.newPrompt)
```

**Behavior:**
- Shown in place of tree when no items exist
- Links trigger creation commands
- Automatically hidden when first item created

## Constants & IDs

### View Identifiers

```typescript
AI_CUSTOMIZATION_VIEWLET_ID = 'workbench.view.aiCustomization'
AI_CUSTOMIZATION_VIEW_ID = 'aiCustomization.view'
AI_CUSTOMIZATION_STORAGE_ID = 'workbench.aiCustomization.views.state'
```

### Category

```typescript
AI_CUSTOMIZATION_CATEGORY = localize2('aiCustomization', "AI Customization")
```

### Menu IDs

```typescript
AICustomizationItemMenuId = new MenuId('aiCustomization.item')
AICustomizationNewMenuId = new MenuId('aiCustomization.new')
```

## User Workflows

### Opening the View

**Via Keybinding:**
1. User presses `Cmd+Shift+I`
2. Sidebar opens to AI Customization view
3. Tree loads and expands categories

**Via Activity Bar:**
1. User clicks AI Customization icon in activity bar
2. View opens in sidebar

**Via Command Palette:**
1. User opens command palette
2. Types "Open AI Customization View"
3. View opens

### Browsing Files

1. User opens AI Customization view
2. Categories auto-expand to show groups
3. User expands group to see files
4. User hovers over file to see full path
5. User double-clicks to open file

### Creating New Items

**Via Toolbar:**
1. User clicks "New" dropdown in toolbar
2. Selects item type (Agent, Skill, etc.)
3. Picker shows existing + create option
4. User selects or creates
5. File opens in editor
6. Tree refreshes to show new file

**Via Welcome Content:**
1. User clicks "Create Agent" link
2. Picker opens
3. Same flow as above

**Via Context Menu:**
1. User right-clicks category or group
2. (Future) "New [Type]" action appears
3. Same flow as above

### Opening Files

**Double-Click:**
1. User double-clicks file in tree
2. File opens in AI Customization Editor (form view)
3. Tree selection remains

**Context Menu - Open:**
1. User right-clicks file
2. Selects "Open"
3. Opens in AI Customization Editor

**Context Menu - Open as Text:**
1. User right-clicks file
2. Selects "Open as Text"
3. Opens in standard text editor

### Running Prompts

1. User right-clicks prompt file
2. Selects "Run Prompt"
3. Prompt executed in chat
4. Chat panel opens with results

### Refreshing

1. User clicks refresh button in toolbar
2. Tree reloads from IPromptsService
3. New/deleted files reflected
4. Categories re-expand automatically

## Styling

**CSS File:** `media/aiCustomizationTreeView.css`

**Key Selectors:**

```css
.ai-customization-category        /* Category items (bold) */
.ai-customization-group-header    /* Group headers (uppercase) */
.ai-customization-tree-item       /* File items */
.icon                             /* Icon elements */
.label                            /* Text labels */
```

**Styling Patterns:**

**Categories:**
- Bold font-weight
- Icon + label flex layout
- 16px icon size

**Groups:**
- Uppercase transform
- 11px font-size
- Letter-spacing: 0.8px
- Description foreground color

**Files:**
- Icon + name flex layout
- Ellipsis overflow
- Normal font-weight

## AI Feature Gating

**Requirement:** View only available when AI features enabled

**Implementation:**
- View descriptor: `when: ChatContextKeys.enabled`
- Actions precondition: `ChatContextKeys.enabled`
- View container hidden when AI disabled

**Behavior:**
- Not visible in empty state when disabled
- Not in activity bar when disabled
- Keybinding disabled when AI disabled

## Integration Points

### IPromptsService

**Methods:**
- `listPromptFilesForStorage(type, storage)` - Get files
- `findAgentSkills()` - Get skills with names
- `onDidChangeCustomAgents` - Reload on change
- `onDidChangeSlashCommands` - Reload on change

**Data Flow:**
1. View subscribes to change events
2. On change, triggers refresh
3. Data source queries service
4. Tree updates with new data

### IEditorService

**Used For:**
- Opening files in AI Customization Editor
- Opening files in text editor
- Overriding default editor

### IMenuService

**Used For:**
- Getting context menu actions
- Resolving menu contributions
- Handling action execution

### IContextMenuService

**Used For:**
- Showing context menus on right-click
- Positioning menus
- Handling menu selection

### IOpenerService

**Used For:**
- Opening URIs from actions
- Handling command links in welcome content

## Performance Considerations

### Lazy Loading

- Tree items rendered on-demand
- Not all categories expanded initially
- Groups only loaded when expanded

### Event Handling

- Service change events debounced
- Refresh operations throttled
- Prevents excessive reloads

### Memory Management

- Proper disposal of tree and renderers
- Event listeners cleaned up
- No memory leaks on view close

## Error Handling

### Service Errors

- Gracefully handle IPromptsService failures
- Show error in tree if can't load
- Allow retry via refresh

### Missing Files

- Handle deleted files gracefully
- Update tree on file system changes
- Show placeholder for missing items

### Parse Errors

- Handle skill frontmatter parse errors
- Fall back to filename
- Log errors for debugging

## Testing Considerations

### Unit Tests

- Data source getChildren logic
- Empty group filtering
- Skill name parsing
- Context key updates

### Integration Tests

- Tree rendering
- Action execution
- Context menus
- Welcome content
- Auto-expansion

## Future Enhancements

### Potential Features

- **Drag & Drop:** Rearrange or move files
- **Inline Rename:** Rename files in tree
- **Inline Create:** Create files inline
- **Badges:** Show file status badges
- **Decorations:** Indicate active/enabled state
- **Group Counts:** Show file counts in groups
- **Filtering:** Filter tree by search query
- **Sorting:** Sort files by name/date

### Architecture Extensions

- Custom tree item types via contributions
- Extension-contributed actions
- Theming customization
- Accessibility improvements

## Related Components

- **AI Customization Editor:** Form-based file editor
- **AI Customization Management:** Global management view
- **Prompts Service:** Core data service
- **Prompt File Pickers:** File creation wizards
- **Chat Integration:** Uses these files

---

*This specification documents the AI Customization Tree View as implemented in `src/vs/workbench/contrib/chat/browser/aiCustomizationTreeView/`*
