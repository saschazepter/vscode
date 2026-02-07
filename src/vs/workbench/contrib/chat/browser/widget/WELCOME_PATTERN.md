# Chat Widget Architecture - Welcome View Pattern

## Problem Statement

Recently added optional delegates (`submitHandler`, `sessionTypePickerDelegate`, `workspacePickerDelegate`) in `IChatWidgetViewOptions` create potential maintainability issues:

1. **Implicit mode detection**: Code infers "welcome mode" from delegate presence rather than explicit flags
2. **Scattered conditionals**: Special-case logic throughout `chatInputPart.ts` checking for delegate existence
3. **Testing complexity**: Cannot test standard chat behavior without accounting for optional delegate paths
4. **Extension difficulty**: Each new special context requires 3+ new optional delegates

## Recommended Pattern: Specialized Widget Classes

Instead of modifying base widget behavior through optional callbacks, create specialized widget classes for different contexts:

### Approach

```
ChatWidget (base)
  ├── StandardChatWidget (panel, editor)  
  ├── WelcomeChatWidget (welcome views)
  └── QuickChatWidget (popup)
```

### Benefits

- **Explicit typing**: `widget instanceof WelcomeChatWidget` vs checking delegates
- **Clear ownership**: Welcome logic in `viewsWelcome/` directory
- **Easier testing**: Test each variant independently
- **Better IntelliSense**: IDE knows which methods are available
- **Cleaner code**: No conditional checks for optional delegates

### Implementation Notes

For welcome-specific behaviors:
- Override `acceptInput()` in `WelcomeChatWidget` for custom submission
- Pass welcome-specific configuration to constructor, not options
- Create `WelcomeInputPart` for picker customization

This follows existing VS Code patterns like `EditorPane` subclasses for different editor types.
