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
┌─────────────────────────────────────────────────┐
│                    Titlebar                     │
├─────────┬────────────────┬──────────────────────┤
│         │                │                      │
│ Sidebar │  Auxiliary Bar │       Editor         │
│         │                │                      │
├─────────┴────────────────┴──────────────────────┤
│                     Panel                       │
└─────────────────────────────────────────────────┘
```

### 2.2 Parts

#### Included Parts

| Part | ID Constant | Position | Default Visibility |
|------|-------------|----------|--------------------|
| Titlebar | `Parts.TITLEBAR_PART` | Top, full width | Always visible |
| Sidebar | `Parts.SIDEBAR_PART` | Left, in middle section | Visible |
| Auxiliary Bar | `Parts.AUXILIARYBAR_PART` | Center-left, in middle section | Visible |
| Editor | `Parts.EDITOR_PART` | Right, in middle section | Hidden (auto-shows when editors open) |
| Panel | `Parts.PANEL_PART` | Bottom, full width | Hidden |

#### Excluded Parts

The following parts from the default workbench are **not included**:

| Part | ID Constant | Reason |
|------|-------------|--------|
| Activity Bar | `Parts.ACTIVITYBAR_PART` | Simplified navigation |
| Status Bar | `Parts.STATUSBAR_PART` | Reduced chrome |
| Banner | `Parts.BANNER_PART` | Not needed |

---

## 3. Grid Structure

The layout uses `SerializableGrid` from `vs/base/browser/ui/grid/grid.js`.

### 3.1 Grid Tree

```
Orientation: VERTICAL (root)
├── Titlebar (leaf, size: titleBarHeight)
├── Middle Section (branch, HORIZONTAL, size: remaining height - panel)
│   ├── Sidebar (leaf, size: 300px default)
│   ├── Auxiliary Bar (leaf, size: 300px default)
│   └── Editor (leaf, size: remaining width)
└── Panel (leaf, size: 300px default)
```

### 3.2 Default Sizes

| Part | Default Size |
|------|--------------|
| Sidebar | 300px width |
| Auxiliary Bar | 300px width |
| Panel | 300px height |
| Titlebar | Determined by `minimumHeight` (~30px) |
| Editor | Remaining space |

---

## 4. Feature Support Matrix

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

## 5. API Reference

### 5.1 Part Visibility

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

### 5.2 Part Sizing

```typescript
// Get current size of a part
getSize(part: Parts): IViewSize

// Set absolute size of a part
setSize(part: Parts, size: IViewSize): void

// Resize by delta values
resizePart(part: Parts, sizeChangeWidth: number, sizeChangeHeight: number): void
```

### 5.3 Focus Management

```typescript
// Focus a specific part
focusPart(part: Parts): void

// Check if a part has focus
hasFocus(part: Parts): boolean

// Focus the editor (default focus target)
focus(): void
```

### 5.4 Container Access

```typescript
// Get the main container or active container
get mainContainer(): HTMLElement
get activeContainer(): HTMLElement

// Get container for a specific part
getContainer(targetWindow: Window, part?: Parts): HTMLElement | undefined
```

### 5.5 Layout Offset

```typescript
// Get offset info for positioning elements
get mainContainerOffset(): ILayoutOffsetInfo
get activeContainerOffset(): ILayoutOffsetInfo
```

Returns `{ top, quickPickTop }` where `top` is the titlebar height.

---

## 6. Events

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

## 7. CSS Classes

### 7.1 Visibility Classes

Applied to `mainContainer` based on part visibility:

| Class | Applied When |
|-------|--------------|
| `nosidebar` | Sidebar is hidden |
| `noauxiliarybar` | Auxiliary bar is hidden |
| `nomaineditorarea` | Editor is hidden |
| `nopanel` | Panel is hidden |

### 7.2 Window State Classes

| Class | Applied When |
|-------|--------------|
| `fullscreen` | Window is in fullscreen mode |
| `maximized` | Window is maximized |

### 7.3 Platform Classes

Applied during workbench render:
- `monaco-workbench`
- `windows` / `linux` / `mac`
- `web` (if running in browser)
- `chromium` / `firefox` / `safari`

---

## 8. File Structure

```
src/vs/workbench/agentSessions/
├── browser/
│   ├── agentSessionsWorkbench.ts   # Main layout implementation
│   └── media/
│       └── agentSessionsWorkbench.css  # Layout-specific styles
└── LAYOUT.md                        # This specification
```

---

## 9. Implementation Requirements

When modifying the Agent Sessions layout:

1. **Maintain fixed positions** — Do not add settings-based position customization
2. **Panel must span full width** — The grid structure requires panel at root level
3. **New parts go in middle section** — Any new parts should be added to the horizontal branch
4. **Update this spec** — All changes must be documented here
5. **Preserve no-op methods** — Unsupported features should remain as no-ops, not throw errors
6. **Handle pane composite lifecycle** — When hiding/showing parts, manage the associated pane composites

---

## 10. Lifecycle

### 10.1 Startup Sequence

1. `constructor()` — Register error handlers
2. `startup()` — Initialize services and layout
3. `initServices()` — Set up service collection, set lifecycle to `Ready`
4. `initLayout()` — Get services, register layout listeners
5. `renderWorkbench()` — Create DOM, create parts, set up notifications
6. `createWorkbenchLayout()` — Build the grid structure
7. `layout()` — Perform initial layout
8. `restore()` — Set lifecycle to `Restored`, then `Eventually`

### 10.2 State Tracking

```typescript
interface IPartVisibilityState {
    sidebar: boolean;
    auxiliaryBar: boolean;
    editor: boolean;
    panel: boolean;
}
```

**Initial state:**

| Part | Initial Visibility |
|------|--------------------|
| Sidebar | `true` (visible) |
| Auxiliary Bar | `true` (visible) |
| Editor | `false` (hidden) |
| Panel | `false` (hidden) |

---

## Revision History

| Date | Change |
|------|--------|
| 2026-02-04 | Editor and Panel hidden by default; Editor auto-shows on editor open, auto-hides when last editor closes |
| Initial | Document created with base layout specification |
