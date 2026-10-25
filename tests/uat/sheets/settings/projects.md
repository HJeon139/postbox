# Settings: Projects

![Settings: Projects](../../screenshots/settings-projects.png)

**Where:** Gear › Projects, or New project… in the Postbox menu.

## Why it exists

Each project has one root folder, where agents start and the picker is bounded.

## Expected functionality

- Lists projects and folders; adds a project with a name and folder.
- Enter on a tab switches to it and keeps focus on the tab (#26).
- No idle archiving (#320): a conversation stays in the sidebar however long nothing happens in it. Its agents’ sessions are archived only with it, and deleted with it.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Add a project with a folder you own.
3. Check there’s no Archive idle conversations setting, and that a conversation you haven’t touched for days is still in the sidebar.

**Pass if:** The project appears in the Postbox menu, and in step 3 nothing has archived itself.
