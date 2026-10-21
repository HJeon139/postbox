# New agent sheet

![New agent sheet](../screenshots/new-agent-sheet.png)

**Where:** + › From a boilerplate, Add an agent…, or New agent on the overview.

## Why it exists

Creating agents happens in the app, with clear control over where they run and what they may do.

## Expected functionality

- Start from a boilerplate; name; runs on (Claude Code, Agent SDK, Mock); model; permissions (Auto default, Ask me, Accept edits, Run everything); folder; description; instructions; tools.
- Joins this conversation or starts a new one; errors show inline.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Create “@tester” from the Critic boilerplate and join the conversation.
3. Try an invalid name (“1x”).

**Pass if:** The agent joins, and the invalid name shows an inline error.
