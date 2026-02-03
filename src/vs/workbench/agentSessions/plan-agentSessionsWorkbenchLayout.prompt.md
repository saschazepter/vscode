## Plan: Agent Sessions Workbench Layout

This plan outlines the implementation of a new `AgentSessionsWorkbench` with a fixed, simplified layout specifically designed for agent session workflows. The layout follows a unique structure: **Sidebar → Auxiliary Bar → Editor** horizontally, with a **full-width Panel** spanning the entire bottom.

**Key Design Decisions:**
- **Fixed layout**: No settings-based customization (no zen mode, no position changes)
- **Parts included**: Titlebar, Sidebar, Auxiliary Bar, Editor, Panel (no Activity Bar, no Statusbar)
- **No maximize support**: Parts cannot be maximized
- **Resizable parts**: Users can resize sidebar, auxiliary bar, and panel by dragging
- **Single file**: Layout and Workbench combined in one file

**Steps**

1. **Create the folder structure** at [src/vs/workbench/agentSessions/](src/vs/workbench/agentSessions/)
   - Create `browser/` subfolder for browser-specific implementation

2. **Create the main AgentSessionsWorkbench file** at `src/vs/workbench/agentSessions/browser/agentSessionsWorkbench.ts`
   - Implement `AgentSessionsWorkbench` class that implements `IWorkbenchLayoutService`
   - Extend `Disposable` for proper lifecycle management
   - Include all required events from the interface (many can be no-ops or return fixed values)
   - Parts to create: `TITLEBAR_PART`, `SIDEBAR_PART`, `AUXILIARYBAR_PART`, `EDITOR_PART`, `PANEL_PART`

3. **Implement the grid layout structure**
   - Use `SerializableGrid` for the layout system
   - Grid structure (vertical orientation):
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
   - Middle section uses `Orientation.HORIZONTAL` for sidebar → auxiliary bar → editor
   - Panel is a sibling of the middle section (not nested inside)

4. **Implement fixed position helpers** - Return constants instead of reading from settings:
   - `getSideBarPosition()`: Always return `Position.LEFT`
   - `getPanelPosition()`: Always return `Position.BOTTOM`
   - `getPanelAlignment()`: Always return `'justify'` (full width)
   - Position setters should be no-ops or throw "not supported"

5. **Implement part visibility methods**
   - `isVisible(part)`: Return visibility state from internal tracking
   - `setPartHidden(hidden, part)`: Update visibility and re-layout
   - Track visibility in a simple `Map<Parts, boolean>`

6. **Implement resize functionality**
   - `getSize(part)`: Get size from grid view
   - `setSize(part, size)`: Set size via grid
   - `resizePart(part, deltaWidth, deltaHeight)`: Resize via grid

7. **Implement required no-op methods** (unsupported features):
   - `toggleZenMode()`: No-op
   - `toggleMaximizedPanel()`: No-op
   - `isPanelMaximized()`: Return `false`
   - `toggleMaximizedAuxiliaryBar()`: No-op
   - `setAuxiliaryBarMaximized()`: Return `false`
   - `isAuxiliaryBarMaximized()`: Return `false`
   - `toggleMenuBar()`: No-op
   - `centerMainEditorLayout()`: No-op
   - `isMainEditorLayoutCentered()`: Return `false`
   - `setPanelPosition()`: No-op
   - `setPanelAlignment()`: No-op

8. **Implement part registration and retrieval**
   - `registerPart(part)`: Store part reference in `Map<string, Part>`
   - `getPart(key)`: Retrieve part from map
   - Parts are created externally and registered during initialization

9. **Implement container methods**
   - `getContainer(targetWindow)`: Return main container
   - `getContainer(targetWindow, part)`: Return part's container element
   - Create `mainContainer` as `document.createElement('div')` with class `'monaco-workbench'`

10. **Implement focus management**
    - `hasFocus(part)`: Check if part contains active element
    - `focusPart(part)`: Delegate to appropriate part's focus method

11. **Implement restore lifecycle**
    - `whenRestored`: Promise that resolves when parts are restored
    - `isRestored()`: Boolean tracking restore state

12. **Create CSS styles** at `src/vs/workbench/agentSessions/browser/agentSessionsWorkbench.css`
    - Import base workbench styles
    - Define layout-specific CSS for the fixed structure
    - No-op classes for hidden states (`.nosidebar`, `.nopanel`, etc.)

13. **Create a plan document** at `src/vs/workbench/agentSessions/LAYOUT.md`
    - Document the layout structure
    - List supported and unsupported features
    - Provide architecture overview for future maintainers

14. **Wire up service registration** (future step, not implemented now)
    - The workbench will need a separate entry point (similar to `desktop.main.ts` / `web.main.ts`)
    - Register `AgentSessionsWorkbench` as `IWorkbenchLayoutService`

**Verification**
- TypeScript compilation via `VS Code - Build` task must pass with no errors
- Run unit tests: `./scripts/test.sh --grep "AgentSessions"` (if tests are added)
- Manual verification: The workbench should render with the correct layout structure

**Decisions**
- **Single file approach**: Chose to combine Layout and Workbench in one file for simplicity, since there's no need for the abstraction layer that the default layout uses
- **No Activity Bar**: Activity bar removed per requirements; sidebar will be the leftmost visible part
- **No Statusbar**: Statusbar removed per requirements; panel will be at the very bottom
- **Grid-based layout**: Reusing the existing `SerializableGrid` infrastructure for consistency and proven resize handling
- **Fixed panel width**: Panel spans full width using `'justify'` alignment to achieve "span entire bottom" requirement
