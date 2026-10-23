# Permissions panel

**Where:** The conversation’s ⋯ › Permissions…; Settings › Personas › an agent › Permissions…; `/permissions` (and `/mcp`) in the composer.

## Why it exists

An agent blocked by a rule shouldn’t send you to a terminal to run `/permissions` ([#66](https://github.com/HJeon139/postbox/issues/66)). The panel shows what one agent may do in one conversation, where each rule comes from, and which rule decides a given call, and lets you change it.

## Expected functionality

- **Agent:** in a room, a choice of agents, starting with the one the composer replies to.
- **Mode:** Auto, Ask me, Accept edits or Run everything. It’s the agent’s mode in every conversation. The panel says when it applies: now, on an Agent SDK turn that’s running and could change; otherwise from the agent’s next turn, since Claude Code can’t change a turn that’s running.
- **Rules:** deny, ask and allow, in Claude Code’s order, each with where it comes from:
  - your user settings (`~/.claude/settings.json`, only when the agent uses your Claude Code setup);
  - the project’s shared settings (`.claude/settings.json`): shown, never changed, since your team shares it;
  - this folder’s local settings (`.claude/settings.local.json`), where the CLI saves “don’t ask again”;
  - this conversation;
  - the persona’s Tools: an unticked tool’s rules, with a button to tick it;
  - “Can publish outside Postbox” being off;
  - Postbox’s check on writes outside it: ask rules for tools and gh commands that create, change or delete something outside Postbox, listed as one row that says what lets a call through (Always allow on its card, or “Can publish” for the tools that covers). None in Run everything ([#112](https://github.com/HJeon139/postbox/issues/112)).
- A settings file that isn’t valid JSON is named, and left as it is.
- **Add a rule:** allow, ask or deny; a tool (Bash, Read, Edit, WebFetch, WebSearch, Agent, or an MCP server or tool); a pattern, with examples for that tool; and where to save it (this folder by default, this conversation only, or your user settings). The rule shows as you type it. Remove takes a rule out of a source Postbox may change.
- **Folders:** where it works, the project’s folder, folders from your settings, and the ones added for this conversation. Add folder… opens the folder picker on the project’s folders, or takes a full path; either applies from the agent’s next turn.
- **MCP servers:** each with its status from the agent’s latest turn, and a checkbox to turn it off for this agent.
- **Which rule decides?** Type a call, such as `Bash(npm test)`, `WebFetch(https://example.com/x)`, `Read(src/a.js)` or `mcp__github__create_issue`, and it says which rule decides, and from where, or that the mode does, and what the mode does with it. It says that Claude Code has the final say.
- A mock agent shows its Tools only, and says modes and rules are for Claude Code and Agent SDK agents.
- Everything works by keyboard. Escape closes the panel, or only the folder picker when one is open over it, and focus goes back to where you opened it.
- It fits a 375 px window without scrolling sideways.

## Steps to reproduce

1. Run `node tools/check-permissions.mjs`. Every line should say ok.
2. Run Postbox with real agents (`node server/index.mjs --port 4181 --data /tmp/pb-uat-real --fresh`) and open <http://127.0.0.1:4181/>, in a project whose folder you can lose. Open a conversation with a Claude Code agent, then ⋯ › Permissions….
3. In “Which rule decides?”, type `Bash(rm -rf build)`. Add a deny rule for Bash with the pattern `rm:*`, and type the call again.
4. In a terminal in that folder, run `claude`, then `/permissions`. Add an allow rule there, and reopen the panel.
5. Set the mode to Accept edits, and send the agent a message.
6. Add a folder from Add folder…, and ask the agent to list it.
7. Open Settings › Personas › the agent › Permissions…, and press Escape.

**Pass if:**
- The call is decided by the mode first, then refused by the new rule, from this folder’s local settings.
- The rule you added in Postbox is in the terminal’s `/permissions`, and the one you added there shows in the panel, from this folder’s local settings.
- The agent’s next turn runs in the new mode, and can read the added folder.
- Escape closes the panel and leaves Settings open.

## Related

- [Permission card](../conversation/harness-cards/permission-card.md)
- [Refusal card](../conversation/harness-cards/refusal-card.md)
- [Conversation menu](top-bar/conversation-menu.md)
