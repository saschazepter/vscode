# Mobile Agent Sessions — Architecture

## Core Principle

**Every feature accessible in the desktop window must be accessible on mobile — same functionality, different presentation.** Mobile is NOT "desktop minus stuff." It is a parallel UI layer where the same services, views, and actions are rendered through mobile-native interaction patterns.

## Architecture

### Mobile Part Subclasses

Desktop Parts (`ChatBarPart`, `SidebarPart`, `PanelPart`, `AuxiliaryBarPart`) remain unchanged. Each has a **mobile subclass** that extends it and overrides only `layout()` and/or `updateStyles()` to remove card margins, border insets, and inline theme styles. `AgenticPaneCompositePartService` conditionally instantiates the mobile or desktop variant at startup based on viewport width (`< 640px` → phone).

This means:
- Desktop code has **zero** phone-layout checks — all mobile logic lives in mobile subclasses, `MobileTopBar`, and CSS.

**Known limitation:** Part classes are chosen once at construction and never swapped at runtime. If the viewport changes class (e.g., device rotation from portrait to landscape), the original Part implementations remain. This is acceptable because real mobile devices don't switch between phone and desktop — the scenario only occurs in DevTools emulation.

### View & Action Gating

Views, menu items, and actions use `when` clauses with the `sessionsIsMobileLayout` context key to control visibility per viewport class. This follows a **default-deny** approach for mobile:

- **Desktop-only features** add `when: IsMobileLayoutContext.negate()` to their view descriptors and menu registrations. They simply don't appear on mobile.
- **Mobile-compatible features** (chat, sessions list) have no mobile gate — they render on all viewports.
- **Mobile-specific replacements** (when ready) register with `when: IsMobileLayoutContext` and live in separate files under `parts/mobile/contributions/`.

Two registrations can target the same slot with opposite `when` clauses, pointing to different view classes in different files — giving full file separation with no internal branching.

#### Current Gating Status

| Feature | Mobile Status | Mechanism |
|---------|--------------|-----------|
| Sessions list (sidebar) | ✅ Compatible | No gate |
| Chat views (ChatBar) | ✅ Compatible | No gate |
| Changes view (AuxiliaryBar) | ❌ Gated | `when: !sessionsIsMobileLayout` on view descriptor |
| Files view (AuxiliaryBar) | ❌ Gated | `when: !sessionsIsMobileLayout` on view descriptor |
| Logs view (Panel) | ❌ Gated | `when: !sessionsIsMobileLayout` on view descriptor |
| Terminal actions | ❌ Gated | `when: !sessionsIsMobileLayout` on menu item |
| "Open in VS Code" action | ❌ Gated | `when: !sessionsIsMobileLayout` on menu item |
| Code review toolbar | ❌ Gated | `when: !sessionsIsMobileLayout` on menu item |
| Customizations toolbar | ❌ Hidden | CSS `display: none` on phone |
| Titlebar | ❌ Hidden | Grid `visible: false` + CSS + MobileTopBar replacement |

### Phone Layout

On phone-sized viewports (`< 640px` width):

```
┌──────────────────────────────────┐
│  [☰]  Session Title          [+] │  ← MobileTopBar (prepended before grid)
├──────────────────────────────────┤
│                                  │
│     Chat (edge-to-edge)          │  ← Grid: ChatBarPart fills 100%
│                                  │
│                                  │
│                                  │
│  ┌──────────────────────────┐    │
│  │  Chat input              │    │  ← Pinned to bottom
│  └──────────────────────────┘    │
└──────────────────────────────────┘
```

- **MobileTopBar** is a DOM element prepended above the grid. It has a hamburger (☰), session title, and new session (+) button.
- **Sidebar** is hidden by default and opens as an **85% width drawer overlay** with a backdrop when the hamburger is tapped. CSS makes its `split-view-view` absolutely positioned with `z-index: 250`. The workbench manually calls `sidebarPart.layout()` with drawer dimensions after opening. Closing the drawer clears the navigation stack.
- **Titlebar** is hidden in the grid (`visible: false`) and via CSS — replaced by MobileTopBar.
- **SessionCompositeBar** (chat tabs) is hidden via CSS.
- The grid uses `display: flex; flex-direction: column` and all `split-view-view:has(> .part)` containers are positioned absolutely at `100% width/height`.

### Viewport Classification

`SessionsLayoutPolicy` classifies the viewport:
- **phone**: `width < 640px`
- **tablet**: `640px ≤ width < 1024px`
- **desktop**: `width ≥ 1024px`

The workbench toggles CSS classes (`phone-layout`, `mobile-layout`) on `layout()` and creates/destroys mobile components when the viewport class changes at runtime (e.g., DevTools device emulation). MobileTopBar lifecycle is managed via a `DisposableStore` that is cleared on viewport transitions to prevent leaks.

### Context Keys

| Key | Type | Purpose |
|-----|------|---------|
| `sessionsViewportClass` | `string` | `'phone'`, `'tablet'`, or `'desktop'` |
| `sessionsIsMobileLayout` | `boolean` | `true` when phone or tablet |
| `sessionsKeyboardVisible` | `boolean` | `true` when virtual keyboard is visible |

### Desktop → Mobile Component Mapping

| Desktop Component | Mobile Equivalent | How Accessed |
|---|---|---|
| **Titlebar** (3-section toolbar) | **MobileTopBar** (☰ / title / +) | Always visible at top |
| **Sidebar** (sessions list) | Drawer overlay (85% width) | Hamburger button (☰) |
| **ChatBar** (chat widget) | Same Part, edge-to-edge, no card chrome | Default view (always visible) |
| **AuxiliaryBar** (files, changes) | Gated — not shown on mobile | Planned: mobile-specific view |
| **Panel** (terminal, output) | Gated — not shown on mobile | Planned: mobile-specific view |
| **SessionCompositeBar** (chat tabs) | Hidden on phone | — |
| **New Session** (sidebar button) | + button in MobileTopBar | Always visible in top bar |

## File Map

### Mobile Part Subclasses

| File | Purpose |
|------|---------|
| `src/vs/sessions/browser/parts/mobile/mobileChatBarPart.ts` | Extends `ChatBarPart`. Overrides `layout()` (no card margins) and `updateStyles()` (no inline card styles). |
| `src/vs/sessions/browser/parts/mobile/mobileSidebarPart.ts` | Extends `SidebarPart`. Overrides `updateStyles()` (no inline card/title styles). |
| `src/vs/sessions/browser/parts/mobile/mobileAuxiliaryBarPart.ts` | Extends `AuxiliaryBarPart`. Overrides `layout()` and `updateStyles()` (no card margins or inline styles). |
| `src/vs/sessions/browser/parts/mobile/mobilePanelPart.ts` | Extends `PanelPart`. Overrides `layout()` and `updateStyles()` (no card margins or inline styles). |

### Mobile Chrome Components

| File | Purpose |
|------|---------|
| `src/vs/sessions/browser/parts/mobile/mobileTopBar.ts` | Phone top bar: hamburger (☰), session title, new session (+). Emits `onDidClickHamburger`, `onDidClickNewSession`, `onDidClickTitle`. |
| `src/vs/sessions/browser/parts/mobile/mobileChatShell.css` | **Single source of truth** for all phone-layout CSS: flex column layout, split-view-view absolute positioning, card chrome removal, part/content width overrides, sidebar title hiding, composite bar hiding, welcome page layout, sash hiding, button focus overrides, mobile pickers. |

### Layout & Navigation

| File | Purpose |
|------|---------|
| `src/vs/sessions/browser/layoutPolicy.ts` | `SessionsLayoutPolicy`: observable viewport classification (phone/tablet/desktop), platform flags (isIOS, isAndroid, isTouchDevice), part visibility and size defaults. |
| `src/vs/sessions/browser/mobileNavigationStack.ts` | `MobileNavigationStack`: Android back button integration via `history.pushState` / `popstate`. Supports `push()`, `pop()`, and `clear()`. |
| `src/vs/sessions/common/contextkeys.ts` | Mobile context keys: `ViewportClassContext`, `IsMobileLayoutContext`, `KeyboardVisibleContext`. |

### Part Instantiation

| File | Purpose |
|------|---------|
| `src/vs/sessions/browser/paneCompositePartService.ts` | `AgenticPaneCompositePartService`: checks viewport width at construction time and instantiates `Mobile*Part` vs desktop `*Part` classes accordingly. |

### Workbench Integration

| File | Key Changes |
|------|-------------|
| `src/vs/sessions/browser/workbench.ts` | Layout policy integration, MobileTopBar creation/destruction (via `DisposableStore`), sidebar drawer open/close with backdrop, viewport-class-change detection, window resize listener, grid height calculation (subtracts MobileTopBar height), titlebar grid visibility toggle, `ISessionsManagementService` for new session button. |
| `src/vs/sessions/browser/parts/chatBarPart.ts` | `_lastLayout` changed from `private` to `protected` for mobile subclass access. |

### Styling

| File | Purpose |
|------|---------|
| `src/vs/sessions/browser/parts/mobile/mobileChatShell.css` | All phone-layout CSS (see above). |
| `src/vs/sessions/browser/parts/media/sidebarPart.css` | Sidebar drawer overlay CSS: 85% width, z-index 250, slide-in animation, backdrop. |
| `src/vs/sessions/browser/media/style.css` | Mobile overscroll containment, 44px touch targets, quick pick bottom sheets, context menu action sheets, dialog sizing, notification positioning, hover card suppression, editor modal full-screen. |

## Remaining Work

- **Session title sync**: MobileTopBar shows hardcoded "New Session" — needs to subscribe to `sessionsManagementService.activeSession` and update title when session changes.
- **Files & Terminal access**: Should become mobile-specific views gated with `when: IsMobileLayoutContext`.
- **iOS keyboard handling**: Adjust layout when virtual keyboard appears (context key exists, but no layout response yet).
- **Session list inline actions**: Make always-visible on touch devices (no hover-to-reveal).
- **Customizations on mobile**: Currently hidden — needs a mobile-friendly alternative.
