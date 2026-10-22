# New agent sheet

![New agent sheet](../screenshots/new-agent-sheet.png)

**Where:** + › From a boilerplate, Add an agent…, or New agent on the overview.

## Why it exists

Creating agents happens in the app, with clear control over where they run and what they may do.

## Expected functionality

- Start from a boilerplate; name; runs on (Claude Code, Agent SDK, Mock); model; permissions (Auto default, Ask me, Accept edits, Run everything); folder; description; instructions; tools.
- On Claude Code or the Agent SDK, two checkboxes with help text: “Uses your Claude Code setup” (on by default; off is Isolated: the project’s settings, plus the folder’s local settings file, where Always allow saves its rules) and “Can publish outside Postbox” (off by default; on allows artifacts and connectors that post or send). Each works with Space or Enter. The mock agent doesn’t show them.
- Where it works: “Join this conversation” (a direct message becomes a room; a room gains an agent; from a topic thread’s +, “Join this topic thread”) or “New conversation in <project>”. The sheet says “conversation”, never “thread” (#4). Errors show inline.
- Space or Enter on a Tools checkbox, a setup checkbox, a boilerplate or a backend option keeps focus on that control as the sheet updates (#26).

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Create “@tester” from the Critic boilerplate and join the conversation.
3. Try an invalid name (“1x”).

**Pass if:** The agent joins, and the invalid name shows an inline error.
