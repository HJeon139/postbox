# Toast

![Toast](../screenshots/toast.png)

**Where:** Bottom right, after actions and blocking events.

## Why it exists

Confirms what just happened and offers the way back (Undo, Restore, Go) without a dialog.

## Expected functionality

- Appears after a delete (with a countdown and Undo), permission requests and other blocking events from other conversations.
- Has an action button when one applies; disappears on its own; is announced to screen readers.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Delete a conversation from its ⋯ menu.
3. Press Undo in the toast before it disappears.

**Pass if:** The toast appears with its countdown, Undo works, and the conversation is back.
