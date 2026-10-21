# Delete session

![Delete session](../screenshots/delete-session-sheet.png)

**Where:** Session menu › Delete session….

## Why it exists

Removing one agent from a room keeps the room readable.

## Expected functionality

- In a room, the agent leaves and its messages stay marked “(deleted)”; alone, the conversation goes; 10 seconds of Undo.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Delete @researcher’s session in “Corpus planning”, then Undo.

**Pass if:** Undo restores the session.
