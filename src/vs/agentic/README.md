# vs/agentic — Agentic Window Layer

## Overview

The `vs/agentic` layer hosts the implementation of the **Agentic Window**, a dedicated workbench experience optimized for agent session workflows. This is a distinct top-level layer within the VS Code architecture, sitting alongside `vs/workbench`.

## Architecture

### Layering Rules

```
vs/base          ← Foundation utilities
vs/platform      ← Platform services
vs/editor        ← Text editor core
vs/workbench     ← Standard workbench
vs/agentic       ← Agentic window (this layer)
```

**Key constraint:** `vs/agentic` may import from `vs/workbench` (and all layers below it), but `vs/workbench` must **never** import from `vs/agentic`. This ensures the standard workbench remains independent of the agentic window implementation.

### Allowed Dependencies

| From `vs/agentic` | Can Import |
|--------------------|------------|
| `vs/base/**` | ✅ |
| `vs/platform/**` | ✅ |
| `vs/editor/**` | ✅ |
| `vs/workbench/**` | ✅ |
| `vs/agentic/**` | ✅ (internal) |

| From `vs/workbench` | Can Import |
|----------------------|------------|
| `vs/agentic/**` | ❌ **Forbidden** |

### Folder Structure

The `vs/agentic` layer follows the same layering conventions as `vs/workbench`:

```
src/vs/agentic/
├── README.md                           ← This specification
├── LAYOUT.md                           ← Layout specification for the agentic workbench
├── browser/                            ← Core workbench implementation
│   ├── agenticWorkbench.ts             ← Main workbench layout
│   ├── agentic.contributions.ts        ← Workbench contributions registration
│   ├── agenticLayoutActions.ts         ← Layout toggle actions
│   ├── agenticWorkbenchMenus.ts        ← Menu IDs for agentic menus
│   ├── agenticTitleBarWidget.ts        ← Title bar session picker widget
│   ├── paneCompositePartService.ts     ← Agentic pane composite part service
│   ├── style.css                       ← Layout styles
│   ├── media/                          ← CSS assets
│   └── parts/                          ← Workbench part implementations
│       ├── agenticTitlebarPart.ts      ← Titlebar part & title service
│       ├── agenticSidebarPart.ts       ← Sidebar part
│       ├── agenticAuxiliaryBarPart.ts  ← Auxiliary bar part
│       ├── agenticPanelPart.ts         ← Panel part
│       ├── editorModal.ts             ← Editor modal overlay
│       ├── floatingToolbar.ts         ← Floating toolbar
│       └── chatbar/                   ← Chat bar part
├── contrib/                            ← Feature contributions (like vs/workbench/contrib/)
│   ├── sessionsView/                   ← Sessions list view
│   │   └── browser/
│   ├── changesView/                    ← File changes view
│   │   └── browser/
│   ├── chatBranchSession/              ← Chat branch session action
│   │   └── browser/
│   ├── aiCustomizationEditor/          ← AI customization single-item editor
│   │   └── browser/
│   ├── aiCustomizationManagement/      ← AI customization management editor
│   │   └── browser/
│   └── aiCustomizationTreeView/        ← AI customization tree view sidebar
│       └── browser/
```

## What is the Agentic Window?

The Agentic Window (`AgenticWorkbench`) provides a simplified, fixed-layout workbench tailored for agent session workflows. Unlike the standard VS Code workbench:

- **Fixed layout** — Part positions are not configurable via settings
- **Simplified chrome** — No activity bar, no status bar, no banner
- **Chat-first UX** — Chat bar is a primary part alongside sidebar and auxiliary bar
- **Modal editor** — Editors appear as modal overlays rather than in the main grid
- **Session-aware titlebar** — Titlebar shows active session with a session picker

See [LAYOUT.md](LAYOUT.md) for the detailed layout specification.

## Adding New Functionality

When adding features to the agentic window:

1. **Core workbench code** (layout, parts, services) goes under `browser/`
2. **Feature contributions** (views, actions, editors) go under `contrib/<featureName>/browser/`
3. Register contributions via `browser/agentic.contributions.ts`
4. Do **not** add imports from `vs/workbench` back to `vs/agentic`
5. Contributions can import from `vs/agentic/browser/` (core) and other `vs/agentic/contrib/*/` modules
6. Update the layout spec (`LAYOUT.md`) for any layout changes
