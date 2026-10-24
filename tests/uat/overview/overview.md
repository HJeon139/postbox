# Overview

![Overview](../screenshots/overview.png)

**Where:** Home (#/), or Overview in the Postbox menu.

## Why it exists

Dispatch mode: several agents work in the background, and you need to see which one needs you and answer quickly.

## Expected functionality

- A card for each session that needs you or is working, what needs you first.
- Below them, under Idle, each idle conversation is one row: its agents’ rings and names, project · conversation, its last message, and when (#3). A conversation that has a card above isn’t listed again. The row opens the conversation, and its ⋯ has Open conversation and Archive conversation, which takes it and its agents off the overview (#101).
- At 1280 × 900 with the demo at its end (three agents need you, one works), every card is above the fold.
- The header counts live sessions, projects, how many need you and how many finished.
- New agent opens the new-agent sheet.
- Archived conversations are listed in a collapsed section at the bottom.
- A conversation where nothing has happened for 7 days (Settings › Projects), with nothing waiting on you, archives itself (#101).
- On a fresh install (no `--demo`), there are three agents, @researcher, @developer and @critic, and no projects or conversations, so the overview has no cards. It says “Create a project to start, or create an agent.” and offers New project, which opens Settings › Projects. They run on Claude Code when it’s installed, and on the mock otherwise. Nothing mentions books or a corpus.
- When Postbox looked for Claude Code at startup and didn’t find it, the overview says so above the cards (or the empty state), with how to install it: “Claude Code isn’t installed here, so agents run on the mock until it is: scripted replies, not a model.” (or “on the Agent SDK or the mock”, when the Agent SDK is installed), then “To run real agents, install Claude Code so `claude --version` works, or set `POSTBOX_CLAUDE_BIN` to where it is, then restart Postbox.” It shows from a fresh install’s first run until Claude Code is installed and Postbox restarted. Under `--demo` or `POSTBOX_BACKENDS=mock`, Postbox doesn’t look, so the line isn’t there (#12).
- With projects but no live sessions, it says to open a project or create an agent.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Let the demo reach the end, then open the overview.

3. Start a fresh install with its own data folder (`node server/index.mjs --port 4181 --data /tmp/pb-uat-first --fresh`) and open <http://127.0.0.1:4181/>.
4. Stop it, and start it again with `POSTBOX_CLAUDE_BIN=/nonexistent/claude` in front, as on a computer without Claude Code.

**Pass if:** The cards that need you come first, every card is above the fold at 1280 × 900, idle conversations are one row each, and the counts match. On the fresh install, the overview is empty apart from how to start, and **Personas** lists only @researcher, @developer and @critic. After step 4, the overview says Claude Code isn’t installed and how to install it; with Claude Code installed, it doesn’t.

## Related

- [session card](session-card.md)
- [session menu](session-menu.md)
