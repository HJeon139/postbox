# Overview

![Overview](../screenshots/overview.png)

**Where:** Home (#/), or Overview in the Postbox menu.

## Why it exists

Dispatch mode: several agents work in the background, and you need to see which one needs you and answer quickly.

## Expected functionality

- One column per live session, most urgent first (needs you, then working, then idle).
- The header counts live sessions, projects, how many need you and how many finished.
- New agent opens the new-agent sheet.
- Archived sessions are listed in a collapsed section at the bottom.
- Topic-thread forks get a column only while working or waiting.
- With no live sessions, it says to open a project or create an agent. On a fresh install, with no projects yet, it says “Create a project to start, or create an agent.” and offers New project, which opens Settings › Projects.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Let the demo reach the end, then open the overview.

**Pass if:** The columns that need you come first and the counts match.

## Related

- [session card](session-card.md)
- [session menu](session-menu.md)
