# Archived sessions

![Archived sessions](../screenshots/archived-sessions.png)

**Where:** Archived in the rail, or #/archived.

## Why it exists

Archiving is the safe default for finished work; this is where it comes back from.

## Expected functionality

- Lists archived sessions with project, conversation and when they were archived.
- Restore brings a session back; Open shows its conversation read-only.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Archive a session, open Archived from the rail, restore it.

**Pass if:** The session moves between the overview and this list.
