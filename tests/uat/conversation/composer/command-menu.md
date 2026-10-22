# Command menu (/)

**Where:** Typing / at the start of a conversation’s composer, or its Commands button (/, beside +).

## Why it exists

The composer should reach what the CLI’s input reaches, without remembering syntax ([#67](https://github.com/HJeon139/postbox/issues/67)): Postbox’s own controls, and the agents’ skills and commands, with what each takes.

## Expected functionality

- **Opening:** typing / at the start of the composer opens the menu, and so does the Commands button, which puts / in the composer. Typing more filters it. ArrowUp and ArrowDown move, Enter or Tab picks, and Escape closes it; focus stays in the composer.
- **Postbox’s commands** run without a turn, on the agent the composer replies to:
  - `/permissions` opens the [permissions panel](../../shell/permissions-panel.md); `/mcp` opens it at the MCP servers.
  - `/mode`, `/model` and `/effort` offer segmented choices; in a room, for any of its agents. The mode is the agent’s, in every conversation; the model and the effort are this conversation’s. Each says when it applies: now, on a running Agent SDK turn that could change, otherwise from the agent’s next turn.
  - `/add-dir` opens the folder picker; the folder is the agent’s from its next turn.
  - `/compact` runs Claude Code’s `/compact` as the agent’s turn (a recorded turn showed it compacts in print mode), and the conversation shows the compaction.
  - `/stop` stops the agents that are working; `/rename` opens the rename sheet; `/archive` archives the agent’s session, with Restore.
- **The agents’ skills and commands:** each agent’s, under its name, from its session’s latest turn (or, before its first, another session of the same persona, marked “from an earlier session”). Commands bound to a terminal, and the ones Postbox runs itself, aren’t listed. Each shows its description and argument hint where Claude Code gives them (the Agent SDK does; the CLI’s list has names only).
- Picking one fills `/name ` and the hint line says what Enter does: “Enter runs /review <file> as @alpha’s turn”. Sending runs it as that agent’s turn, as the whole prompt, and the line shows in the conversation as yours. What it missed reaches it on its next turn.
- A line that names no command is sent as a message.
- In a thread panel, / and ! are plain text.

## Steps to reproduce

1. Run `node tools/check-commands.mjs`. Every line should say ok.
2. Run Postbox with real agents (`node server/index.mjs --port 4181 --data /tmp/pb-uat-real --fresh`) and open <http://127.0.0.1:4181/>. Make a room with two Claude Code agents, and send each a message so their sessions start.
3. Type /. Check both agents’ groups, then type `rev` and pick a skill that takes arguments, such as a review skill. Add its argument and send.
4. Type /effort, choose High for the second agent, and send it a message.
5. Press the Commands button, pick /compact, and send.

**Pass if:**
- The menu lists the same skills and commands as `claude` in that folder, apart from the terminal-only ones.
- The skill ran as the agent you picked, with your argument.
- The second agent’s next turn ran at high effort, and the first one’s didn’t change.
- /compact shows a compaction in the conversation.

## Related

- [Composer](composer.md)
- [Mention menu](mention-menu.md)
- [Command item (!)](../transcript/command-item.md)
