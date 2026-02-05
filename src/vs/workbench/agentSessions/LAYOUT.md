# Agent Sessions Workbench Layout Specification

This document is the **authoritative specification** for the Agent Sessions workbench layout. All implementation changes must be reflected here, and all development work should reference this document.

---

## 1. Overview

The Agent Sessions Workbench (`AgentSessionsWorkbench`) provides a simplified, fixed layout optimized for agent session workflows. Unlike the default VS Code workbench, this layout:

- Does **not** support settings-based customization
- Has **fixed** part positions
- Excludes several standard workbench parts

---

## 2. Layout Structure

### 2.1 Visual Representation

```
┌─────────────────────────────────────────────────────────────────┐
│                            Titlebar                             │
├────────────┬─────────┬────────────────────────┬─────────────────┤
│            │         │                        │                 │
│ Project    │ Sidebar │       Chat Bar         │  Auxiliary Bar  │
│ Bar        │         │                        │                 │
├────────────┴─────────┴────────────────────────┴─────────────────┤
│                             Panel                               │
└─────────────────────────────────────────────────────────────────┘

         ┌───────────────────────────────────────┐
         │     ╔═══════════════════════════╗     │
         │     ║    Editor Modal Overlay   ║     │
         │     ║  ┌─────────────────────┐  ║     │
         │     ║  │ [header]        [X] │  ║     │
         │     ║  ├─────────────────────┤  ║     │
         │     ║  │                     │  ║     │
         │     ║  │    Editor Part      │  ║     │
         │     ║  │                     │  ║     │
         │     ║  │                     │  ║     │
         │     ║  └─────────────────────┘  ║     │
         │     ╚═══════════════════════════╝     │
         └───────────────────────────────────────┘
               (shown when editors are open)
```

### 2.2 Parts

#### Included Parts

| Part | ID Constant | Position | Default Visibility | ViewContainerLocation |
|------|-------------|----------|------------|----------------------|
| Titlebar | `Parts.TITLEBAR_PART` | Top, full width | Always visible | — |
| Project Bar | `Parts.PROJECTBAR_PART` | Left-most, in middle section | Visible | — |
| Sidebar | `Parts.SIDEBAR_PART` | Left of center, in middle section | Visible | `ViewContainerLocation.Sidebar` |
| Chat Bar | `Parts.CHATBAR_PART` | Center, takes remaining width | Visible | `ViewContainerLocation.ChatBar` |
| Editor | `Parts.EDITOR_PART` | **Modal overlay** (not in grid) | Hidden | — |
| Auxiliary Bar | `Parts.AUXILIARYBAR_PART` | Right, in middle section | Visible | `ViewContainerLocation.AuxiliaryBar` |
| Panel | `Parts.PANEL_PART` | Bottom, full width | Hidden | `ViewContainerLocation.Panel` |

#### Excluded Parts

The following parts from the default workbench are **not included**:

| Part | ID Constant | Reason |
|------|-------------|--------|
| Activity Bar | `Parts.ACTIVITYBAR_PART` | Simplified navigation |
| Status Bar | `Parts.STATUSBAR_PART` | Reduced chrome |
| Banner | `Parts.BANNER_PART` | Not needed |

---

## 3. Titlebar Configuration

The Agent Sessions workbench uses a customized titlebar with reduced functionality compared to the default workbench.

### 3.1 Titlebar Options

The titlebar is configured via `ITitlebarPartConfiguration` passed to the title service:

| Option | Default Workbench | Agent Sessions | Notes |
|--------|-------------------|----------------|-------|
| `supportsCommandCenter` | `true` | `false` | No command center in titlebar |
| `supportsMenubar` | `true` | `false` | No menubar in titlebar |
| `supportsEditorActions` | `true` | `false` | No editor actions in titlebar |
| `supportsActivityActions` | `true` | `true` | Activity actions supported |
| `supportsGlobalActions` | `true` | `true` | Global actions supported |
| `supportsLayoutActions` | `true` | `true` | Layout actions supported |
| `contextMenuId` | `MenuId.TitleBarContext` | `MenuId.TitleBarContext` | Default context menu |
| `leftToolbarMenuId` | `undefined` | `MenuId.TitleBarLeft` | Custom left toolbar |

### 3.2 Left Toolbar

The Agent Sessions titlebar includes a custom left toolbar that appears after the app icon. This toolbar:

- Uses `MenuId.TitleBarLeft` for its actions
- Uses `HiddenItemStrategy.NoHide` so actions cannot be hidden by users
- Displays actions registered to `MenuId.TitleBarLeft`

### 3.3 Titlebar Actions

| Action | ID | Location | Behavior |
|--------|-----|----------|----------|
| Toggle Sidebar | `workbench.action.agentToggleSidebarVisibility` | Left toolbar | Toggles primary sidebar visibility |

The toggle sidebar action:
- Shows `layoutSidebarLeft` icon when sidebar is visible
- Shows `layoutSidebarLeftOff` icon when sidebar is hidden
- Bound to `Ctrl+B` / `Cmd+B` keybinding
- Announces visibility changes to screen readers

---

## 4. Grid Structure

The layout uses `SerializableGrid` from `vs/base/browser/ui/grid/grid.js`.

### 4.1 Grid Tree

The Editor part is **not** in the grid — it is rendered as a modal overlay (see Section 4.3).

```
Orientation: VERTICAL (root)
├── Titlebar (leaf, size: titleBarHeight)
├── Middle Section (branch, HORIZONTAL, size: remaining height - panel)
│   ├── Project Bar (leaf, size: 48px)
│   ├── Sidebar (leaf, size: 300px default)
│   ├── Chat Bar (leaf, size: remaining width)
│   └── Auxiliary Bar (leaf, size: 300px default)
└── Panel (leaf, size: 300px default, hidden by default)
```

### 4.2 Default Sizes

| Part | Default Size |
|------|--------------|
| Project Bar | 48px width (fixed) |
| Sidebar | 300px width |
| Auxiliary Bar | 300px width |
| Chat Bar | Remaining space |
| Editor Modal | 80% of workbench (min 400x300, max 1200x900), calculated in TypeScript |
| Panel | 300px height |
| Titlebar | Determined by `minimumHeight` (~30px) |

### 4.3 Editor Modal

The Editor part is rendered as a **modal overlay** rather than being part of the grid. This provides a focused editing experience that hovers above the main workbench layout.

#### Modal Structure

```
EditorModal
├── Overlay (semi-transparent backdrop)
├── Container (centered dialog)
│   ├── Header (32px, contains close button)
│   └── Content (editor part fills remaining space)
```

#### Behavior

| Trigger | Action |
|---------|--------|
| Editor opens (`onWillOpenEditor`) | Modal shows automatically |
| All editors close | Modal hides automatically |
| Click backdrop | Close all editors, hide modal |
| Click close button (X) | Close all editors, hide modal |
| Press Escape key | Close all editors, hide modal |

#### Modal Sizing

Modal dimensions are calculated in TypeScript rather than CSS. The `EditorModal.layout()` method receives workbench dimensions and computes the modal size with constraints:

| Property | Value | Constant |
|----------|-------|----------|
| Size Percentage | 80% of workbench | `MODAL_SIZE_PERCENTAGE = 0.8` |
| Max Width | 1200px | `MODAL_MAX_WIDTH = 1200` |
| Max Height | 900px | `MODAL_MAX_HEIGHT = 900` |
| Min Width | 400px | `MODAL_MIN_WIDTH = 400` |
| Min Height | 300px | `MODAL_MIN_HEIGHT = 300` |
| Header Height | 32px | `MODAL_HEADER_HEIGHT = 32` |

The calculation:
```typescript
modalWidth = min(MODAL_MAX_WIDTH, max(MODAL_MIN_WIDTH, workbenchWidth * MODAL_SIZE_PERCENTAGE))
modalHeight = min(MODAL_MAX_HEIGHT, max(MODAL_MIN_HEIGHT, workbenchHeight * MODAL_SIZE_PERCENTAGE))
contentHeight = modalHeight - MODAL_HEADER_HEIGHT
```

#### CSS Classes

| Class | Applied To | Notes |
|-------|------------|-------|
| `editor-modal-overlay` | Overlay container | Positioned absolute, full size |
| `editor-modal-overlay.visible` | When modal is shown | Enables pointer events |
| `editor-modal-backdrop` | Semi-transparent backdrop | Clicking closes modal |
| `editor-modal-container` | Centered modal dialog | Width/height set in TypeScript |
| `editor-modal-header` | Header with close button | Fixed 32px height |
| `editor-modal-content` | Editor content area | Width/height set in TypeScript |
| `editor-modal-visible` | Added to `mainContainer` when modal is visible | — |

#### Implementation

The modal is implemented in `EditorModal` class (`parts/editorModal.ts`):

```typescript
class EditorModal extends Disposable {
    // Events
    readonly onDidChangeVisibility: Event<boolean>;

    // State
    get visible(): boolean;

    // Methods
    show(): void;   // Show modal using stored dimensions
    hide(): void;   // Hide modal
    close(): void;  // Close all editors, then hide
    layout(workbenchWidth: number, workbenchHeight: number): void; // Store dimensions, re-layout if visible
}
```

The `AgentSessionsWorkbench.layout()` passes the workbench dimensions to `EditorModal.layout()`, which calculates and applies the modal size with min/max constraints. Dimensions are stored so that `show()` can use them when the modal becomes visible.

---

## 5. Feature Support Matrix

| Feature | Default Workbench | Agent Sessions | Notes |
|---------|-------------------|----------------|-------|
| Activity Bar | ✅ Configurable | ❌ Not included | — |
| Status Bar | ✅ Configurable | ❌ Not included | — |
| Sidebar Position | ✅ Left/Right | 🔒 Fixed: Left | `getSideBarPosition()` returns `Position.LEFT` |
| Panel Position | ✅ Top/Bottom/Left/Right | 🔒 Fixed: Bottom | `getPanelPosition()` returns `Position.BOTTOM` |
| Panel Alignment | ✅ Left/Center/Right/Justify | 🔒 Fixed: Justify | `getPanelAlignment()` returns `'justify'` |
| Maximize Panel | ✅ Supported | ❌ No-op | `toggleMaximizedPanel()` does nothing |
| Maximize Auxiliary Bar | ✅ Supported | ❌ No-op | `toggleMaximizedAuxiliaryBar()` does nothing |
| Zen Mode | ✅ Supported | ❌ No-op | `toggleZenMode()` does nothing |
| Centered Editor Layout | ✅ Supported | ❌ No-op | `centerMainEditorLayout()` does nothing |
| Menu Bar Toggle | ✅ Supported | ❌ No-op | `toggleMenuBar()` does nothing |
| Resize Parts | ✅ Supported | ✅ Supported | Via grid or programmatic API |
| Hide/Show Parts | ✅ Supported | ✅ Supported | Via `setPartHidden()` |
| Window Maximized State | ✅ Supported | ✅ Supported | Tracked per window ID |
| Fullscreen | ✅ Supported | ✅ Supported | CSS class applied |

---

## 6. API Reference

### 6.1 Part Visibility

```typescript
// Check if a part is visible
isVisible(part: Parts): boolean

// Show or hide a part
setPartHidden(hidden: boolean, part: Parts): void
```

**Behavior:**
- Hiding a part also hides its active pane composite
- Showing a part restores the last active pane composite
- **Editor Part Auto-Visibility:**
  - Automatically shows when an editor is about to open (`onWillOpenEditor`)
  - Automatically hides when the last editor closes (`onDidCloseEditor` + all groups empty)

### 6.2 Part Sizing

```typescript
// Get current size of a part
getSize(part: Parts): IViewSize

// Set absolute size of a part
setSize(part: Parts, size: IViewSize): void

// Resize by delta values
resizePart(part: Parts, sizeChangeWidth: number, sizeChangeHeight: number): void
```

### 6.3 Focus Management

```typescript
// Focus a specific part
focusPart(part: Parts): void

// Check if a part has focus
hasFocus(part: Parts): boolean

// Focus the editor (default focus target)
focus(): void
```

### 6.4 Container Access

```typescript
// Get the main container or active container
get mainContainer(): HTMLElement
get activeContainer(): HTMLElement

// Get container for a specific part
getContainer(targetWindow: Window, part?: Parts): HTMLElement | undefined
```

### 6.5 Layout Offset

```typescript
// Get offset info for positioning elements
get mainContainerOffset(): ILayoutOffsetInfo
get activeContainerOffset(): ILayoutOffsetInfo
```

Returns `{ top, quickPickTop }` where `top` is the titlebar height.

---

## 7. Events

| Event | Fired When |
|-------|------------|
| `onDidChangePartVisibility` | Any part visibility changes |
| `onDidLayoutMainContainer` | Main container is laid out |
| `onDidLayoutActiveContainer` | Active container is laid out |
| `onDidLayoutContainer` | Any container is laid out |
| `onDidChangeWindowMaximized` | Window maximized state changes |
| `onDidChangeNotificationsVisibility` | Notification visibility changes |
| `onWillShutdown` | Workbench is about to shut down |
| `onDidShutdown` | Workbench has shut down |

**Events that never fire** (unsupported features):
- `onDidChangeZenMode`
- `onDidChangeMainEditorCenteredLayout`
- `onDidChangePanelAlignment`
- `onDidChangePanelPosition`
- `onDidChangeAuxiliaryBarMaximized`

---

## 8. CSS Classes

### 8.1 Visibility Classes

Applied to `mainContainer` based on part visibility:

| Class | Applied When |
|-------|--------------|
| `nosidebar` | Sidebar is hidden |
| `noprojectbar` | Project bar is hidden |
| `nomaineditorarea` | Editor modal is hidden |
| `noauxiliarybar` | Auxiliary bar is hidden |
| `nochatbar` | Chat bar is hidden |
| `nopanel` | Panel is hidden |
| `editor-modal-visible` | Editor modal is visible |

### 8.2 Window State Classes

| Class | Applied When |
|-------|--------------|
| `fullscreen` | Window is in fullscreen mode |
| `maximized` | Window is maximized |

### 8.3 Platform Classes

Applied during workbench render:
- `monaco-workbench`
- `windows` / `linux` / `mac`
- `web` (if running in browser)
- `chromium` / `firefox` / `safari`

---

## 9. Agent Session Parts

The Agent Sessions workbench uses specialized part implementations that extend the base pane composite infrastructure but are simplified for agent session contexts.

### 9.1 Part Classes

| Part | Class | Extends | Location |
|------|-------|---------|----------|
| Project Bar | `ProjectBarPart` | `Part` | `agentSessions/browser/parts/projectbar/projectBarPart.ts` |
| Sidebar | `AgentSessionSidebarPart` | `AbstractPaneCompositePart` | `agentSessions/browser/parts/agentSessionSidebarPart.ts` |
| Auxiliary Bar | `AgentSessionAuxiliaryBarPart` | `AbstractPaneCompositePart` | `agentSessions/browser/parts/agentSessionAuxiliaryBarPart.ts` |
| Panel | `AgentSessionPanelPart` | `AbstractPaneCompositePart` | `agentSessions/browser/parts/agentSessionPanelPart.ts` |
| Editor Modal | `EditorModal` | `Disposable` | `agentSessions/browser/parts/editorModal.ts` |

### 9.2 Project Bar

The Project Bar is a new part specific to the Agent Sessions workbench that displays workspace folders and allows selection between them.

#### Features

| Feature | Description |
|---------|-------------|
| Workspace folder display | Shows first letter of each workspace folder as an icon button |
| Folder selection | Click to select and switch between workspace folders |
| Add folder button | Button with `+` icon to add new folders via `workbench.action.addRootFolder` command |
| Hover tooltips | Shows full folder name on hover |
| Keyboard navigation | Supports `Tab`, `Enter`, and `Space` for accessibility |

#### Visual Style

- Uses Activity Bar styling (`ACTIVITY_BAR_BACKGROUND`, `ACTIVITY_BAR_BORDER`)
- Fixed width: 48px (same as activity bar)
- Action item height: 48px
- Selected folder shows `checked` class with active indicator

#### Events

| Event | Fired When |
|-------|------------|
| `onDidSelectWorkspace` | User selects a different workspace folder |

#### API

```typescript
class ProjectBarPart extends Part {
    // Properties
    readonly minimumWidth: number = 48;
    readonly maximumWidth: number = 48;
    get selectedWorkspaceFolder(): IWorkspaceFolder | undefined;

    // Events
    readonly onDidSelectWorkspace: Event<IWorkspaceFolder | undefined>;
}
```

### 9.3 Key Differences from Standard Parts

| Feature | Standard Parts | Agent Session Parts |
|---------|----------------|---------------------|
| Activity Bar integration | Full support | No activity bar (replaced by Project Bar) |
| Composite bar position | Configurable (top/bottom/title/hidden) | Fixed: Title |
| Auto-hide support | Configurable | Disabled |
| Configuration listening | Many settings | Minimal |
| Context menu actions | Full set | Simplified |

### 9.4 Part Selection

Each workbench layout is responsible for passing the appropriate pane composite part descriptors to the `PaneCompositePartService`. The parts are defined as `SyncDescriptor0` instances via `IPaneCompositePartsConfiguration`, and the service lazily instantiates them when first requested:

```typescript
// In agentSessionsWorkbench.ts (initServices)
const paneCompositePartsConfiguration: IPaneCompositePartsConfiguration = {
    panelPart: new SyncDescriptor(AgentSessionPanelPart),
    sideBarPart: new SyncDescriptor(AgentSessionSidebarPart),
    auxiliaryBarPart: new SyncDescriptor(AgentSessionAuxiliaryBarPart),
    chatBarPart: new SyncDescriptor(ChatBarPart),
};
serviceCollection.set(IPaneCompositePartService, new SyncDescriptor(PaneCompositePartService, [paneCompositePartsConfiguration]));
```

This architecture ensures that:
1. The `PaneCompositePartService` has no knowledge of the workspace type—it simply receives part descriptors from the layout class
2. Parts are only instantiated when first accessed, enabling lazy initialization

### 9.5 Storage Keys

Each agent session part uses separate storage keys to avoid conflicts with regular workbench state:

| Part | Setting | Storage Key |
|------|---------|-------------|
| Sidebar | Active viewlet | `workbench.agentsession.sidebar.activeviewletid` |
| Auxiliary Bar | Active panel | `workbench.agentsession.auxiliarybar.activepanelid` |
| Auxiliary Bar | Pinned views | `workbench.agentsession.auxiliarybar.pinnedPanels` |
| Auxiliary Bar | Placeholders | `workbench.agentsession.auxiliarybar.placeholderPanels` |
| Auxiliary Bar | Workspace state | `workbench.agentsession.auxiliarybar.viewContainersWorkspaceState` |
| Panel | Active panel | `workbench.agentsession.panelpart.activepanelid` |
| Panel | Pinned panels | `workbench.agentsession.panel.pinnedPanels` |
| Panel | Placeholders | `workbench.agentsession.panel.placeholderPanels` |
| Panel | Workspace state | `workbench.agentsession.panel.viewContainersWorkspaceState` |

---

## 10. File Structure

```
src/vs/workbench/agentSessions/
├── browser/
│   ├── agentSessions.contributions.ts      # Workbench contributions
│   ├── agentSessionsWorkbench.ts           # Main layout implementation
│   ├── agentSessions.contributions.ts      # View registrations and contributions
│   ├── agentSessionsLayoutActions.ts       # Layout actions (toggle sidebar, etc.)
│   ├── style.css                           # Layout-specific styles (including editor modal)
│   ├── parts/
│   │   ├── agentSessionSidebarPart.ts      # Agent session sidebar
│   │   ├── agentSessionAuxiliaryBarPart.ts # Agent session auxiliary bar
│   │   ├── agentSessionPanelPart.ts        # Agent session panel
│   │   ├── editorModal.ts                  # Editor modal overlay implementation
│   │   ├── chatbar/
│   │   │   ├── chatBarPart.ts              # Chat Bar part implementation
│   │   │   └── media/
│   │   │       └── chatBarPart.css         # Chat Bar styles
│   │   └── projectbar/
│   │       ├── projectBarPart.ts           # Project Bar part implementation
│   │       └── projectBarPart.css          # Project Bar styles
└── LAYOUT.md                               # This specification
```

---

## 11. Implementation Requirements

When modifying the Agent Sessions layout:

1. **Maintain fixed positions** — Do not add settings-based position customization
2. **Panel must span full width** — The grid structure requires panel at root level
3. **New parts go in middle section** — Any new parts should be added to the horizontal branch
4. **Update this spec** — All changes must be documented here
5. **Preserve no-op methods** — Unsupported features should remain as no-ops, not throw errors
6. **Handle pane composite lifecycle** — When hiding/showing parts, manage the associated pane composites
7. **Use agent session parts** — New functionality for parts should be added to the agent session part classes, not the standard parts

---

## 12. Lifecycle

### 12.1 Startup Sequence

1. `constructor()` — Register error handlers
2. `startup()` — Initialize services and layout
3. `initServices()` — Set up service collection, set lifecycle to `Ready`
4. `initLayout()` — Get services, register layout listeners
5. `renderWorkbench()` — Create DOM, create parts, set up notifications
6. `createWorkbenchLayout()` — Build the grid structure
7. `layout()` — Perform initial layout
8. `restore()` — Restore parts (open default view containers), set lifecycle to `Restored`, then `Eventually`

### 12.2 Part Restoration

During the `restore()` phase, `restoreParts()` is called to open the default view container for each visible part:

```typescript
private restoreParts(): void {
    const partsToRestore = [
        { location: ViewContainerLocation.Sidebar, visible: this.partVisibility.sidebar },
        { location: ViewContainerLocation.Panel, visible: this.partVisibility.panel },
        { location: ViewContainerLocation.AuxiliaryBar, visible: this.partVisibility.auxiliaryBar },
        { location: ViewContainerLocation.ChatBar, visible: this.partVisibility.chatBar },
    ];

    for (const { location, visible } of partsToRestore) {
        if (visible) {
            const defaultViewContainer = this.viewDescriptorService.getDefaultViewContainer(location);
            if (defaultViewContainer) {
                this.paneCompositeService.openPaneComposite(defaultViewContainer.id, location);
            }
        }
    }
}
```

This ensures that when a part is visible, its default view container is automatically opened and displayed.

### 12.3 State Tracking

```typescript
interface IPartVisibilityState {
    sidebar: boolean;
    projectBar: boolean;
    auxiliaryBar: boolean;
    editor: boolean;
    panel: boolean;
    chatBar: boolean;
}
```

**Initial state:**

| Part | Initial Visibility |
|------|--------------------|
| Sidebar | `true` (visible) |
| Project Bar | `true` (visible) |
| Auxiliary Bar | `true` (visible) |
| Chat Bar | `true` (visible) |
| Editor | `false` (hidden) |
| Panel | `false` (hidden) |

---

## Revision History

| Date | Change |
|------|--------|
| 2026-02-05 | Added configurable titlebar via `ITitlebarPartOptions` and `ITitlebarPartConfiguration`; Titlebar now disables command center, menubar, and editor actions; Added left toolbar with `MenuId.TitleBarLeft`; Added `ToggleSidebarVisibilityAction` in `agentSessionsLayoutActions.ts` |
| 2026-02-05 | Added Project Bar part (`ProjectBarPart`) to display and select workspace folders; Layout order is now Project Bar \| Sidebar \| Chat Bar \| Auxiliary Bar |
| 2026-02-04 | Modal sizing (80%, min/max constraints) moved from CSS to TypeScript; `EditorModal.layout()` now accepts workbench dimensions |
| 2026-02-04 | Editor now renders as modal overlay instead of in grid; Added `EditorModal` class in `parts/editorModal.ts`; Closing modal closes all editors; Grid layout is now Sidebar \| Chat Bar \| Auxiliary Bar |
| 2026-02-04 | Changed part creation to use `SyncDescriptor0` for lazy instantiation—parts are created when first accessed, not at service construction time |
| 2026-02-04 | Refactored part creation: each layout class now creates and passes parts to `PaneCompositePartService` via `IPaneCompositePartsConfiguration`, removing `isAgentSessionsWorkspace` dependency from the service |
| 2026-02-04 | Added `restoreParts()` to automatically open default view containers for visible parts during startup |
| 2026-02-04 | Restored Editor part; Layout order is now Sidebar \| Chat Bar \| Editor \| Auxiliary Bar |
| 2026-02-04 | Removed Editor part; Chat Bar now takes max width; Layout order changed to Sidebar \| Auxiliary Bar \| Chat Bar |
| 2026-02-04 | Added agent session specific parts (AgentSessionSidebarPart, AgentSessionAuxiliaryBarPart, AgentSessionPanelPart) in `agentSessions/browser/parts/`; PaneCompositePartService now selects parts based on isAgentSessionsWorkspace |
| 2026-02-04 | Editor and Panel hidden by default; Editor auto-shows on editor open, auto-hides when last editor closes |
| 2026-02-04 | Added Chat Bar part with `ViewContainerLocation.ChatBar` |
| Initial | Document created with base layout specification |
