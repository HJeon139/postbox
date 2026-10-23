# Agents section and quick panel

![Agents section](../../screenshots/agents-section.png)

![An agent’s quick panel](../../screenshots/agent-quick-panel.png)

**Where:** In the sidebar, the open conversation’s Agents, above Direct messages. In a topic thread’s panel, “Agents in this thread”. Each agent’s ring in the top bar opens the same quick panel.

## Why it exists

One agent’s settings were in four places: `/model`, `/effort` and `/mode` in the composer; rules, folders and MCP servers in the permissions panel; tools only in Settings › Personas; and its state in a top-bar chip. In #104 the person couldn’t tell that @critic’s shell was off, because the tools were two screens away. The chips also crowded the top bar until the title read “UseCase - E…”. A topic thread had no way to change any of it, because its composer has no `/` (#105).

## Expected functionality

- One row per agent: its ring, `@handle` (“mock” after it on the mock), its state in words (“· idle”, “· calling tools”), and on a second line the model that answered its last turn and the effort (“Sonnet 5.5, not Opus 5.5 · medium effort”). A mock agent has no second line. Each part follows the agent live.
- An agent with blocks left open from earlier turns shows a quiet “1 open review” button under its row, which scrolls to the block and focuses it (#69). The quick panel shows it too.
- Clicking a row, or Enter on it, opens its quick panel beside the row. In a narrow window it opens as a sheet, like any dialog. It’s a dialog named after the agent, and focus starts on its model.
- **In this conversation** (or **In this thread**): Model and Effort, as segmented choices. A choice takes effect from the agent’s next turn, as `/model` and `/effort` do, and only for this conversation’s session; a topic thread’s are its own.
- **For @handle everywhere**: Permission mode (Auto, Ask me, Accept edits, Run everything) and Tools (Shell, Web, Agents outside Postbox), which are the persona’s and apply to every conversation it’s in. Each tool is a switch that says On or Off in words, with what turning it off means under it (“Off: it can’t run commands. It can still read and search files.”).
- Every control’s name carries its scope too, so a screen reader hears it on the control: “Model, in this conversation”, “Shell, for @critic everywhere”.
- After a change, a line under the controls says what changed and when it takes effect (“Model: Sonnet 5.5 for @indexer in this conversation, from its next turn.”), and it’s announced.
- “Rules, folders and MCP…” opens the [permissions panel](../permissions-panel.md) on this agent (not on a Kiro agent, which doesn’t read them). “Edit persona…” opens Settings › Personas on it.
- Stop (only while it works; while its process exits it reads “stopping”, and Stop isn’t offered again; with background jobs running, it closes the panel and the conversation asks whether to stop them too), Compact (on a real backend, while idle; it runs `/compact` as the agent’s turn, as the composer’s `/compact` does) and Archive (with Restore in the toast).
- A mock agent says it has no model, effort or permission mode to change; its tools still show.
- By keyboard: each group of choices is one Tab stop; the arrow keys move within it, and Enter or Space picks. Space or Enter flips a switch. Escape closes the panel and returns focus to the row or ring it came from.
- Model and effort changed elsewhere (`/model`, another tab) show in the open panel at once.
- An agent the person never added, which joined because another agent woke it in a side thread, says so under its row (“Joined when @indexer woke it”) and on its ring in the top bar; the wake’s line in the conversation ends “joined the conversation” (#110).
- **The agent tree** (#121, #110). Under an agent’s row, a short entry each, wrapped rather than cut: its turn when it answers in a side thread (“Calling tools with @indexer”), and each fork of it that answered there while its session was busy elsewhere (“Fork · calling tools with @indexer”), each with a Stop while it works. Each entry opens its side thread; hovering it shows which thread and who woke it. A persona running in two sessions shows two entries, and one of them waiting for you counts in “needs you”, ⌃J and the tab title.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “Corpus planning”. Check the Agents section above Direct messages.
3. Click @indexer’s row, then Ask me under Permission mode. Close, click the row again, then the Shell switch. Do the same for Model and Effort.
4. Tab to a row, press Enter, Tab through the panel, flip a switch with Space, and press Escape.
5. Under an agent reply, choose Reply in thread. In the thread’s panel, open its agent’s quick panel and change its model; the conversation’s agent keeps its own.
6. Narrow the window to 375 px. Open the panel from a ring in the top bar (in a room, from the stack of rings’ menu), and from a topic thread’s panel.
7. In a room, ask @indexer to wake @researcher with a long task, and while @researcher works in the side thread, have @indexer wake it again. Check the tree under @researcher, the side-thread line, and `/stop` in the conversation.
8. Run `node tools/check-agents.mjs` and `node tools/check-side-threads.mjs`.

**Pass if:** Each change takes two clicks from the sidebar, with no command, in a conversation and in a topic thread; every control says whether it’s for this conversation or for the persona everywhere; the panel works by keyboard and fits at 375 and 1280 px; an agent at work in a side thread, and each fork of it, shows under its row with a Stop; and the checks pass.

## Related

- [rail](rail.md)
- [top bar](../top-bar/top-bar.md)
- [permissions panel](../permissions-panel.md)
- [topic thread panel](../../conversation/panels/topic-thread-panel.md)
