# Settings: Personas

![Settings: Personas](../../screenshots/settings-personas.png)

**Where:** Gear › Personas, or Personas in the rail.

## Why it exists

Agents are edited in the app; edits apply to new sessions, and where an agent runs and its permissions apply from the next turn.

## Expected functionality

- Lists personas with Edit; the editor ([screenshot](../../screenshots/settings-persona-editor.png)) changes description, instructions, runs on, model, permissions, folder and tools; Retire and Bring back.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Edit @critic’s permissions to Ask me and save.

**Pass if:** The save confirmation says when it applies.
