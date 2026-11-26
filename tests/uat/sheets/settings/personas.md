# Settings: Personas

![Settings: Personas](../../screenshots/settings-personas.png)

**Where:** Settings › Personas, or Personas in the rail.

## Why it exists

Agents are edited in the app, in this one place. Every edit applies from each agent’s next turn, in every conversation it’s in; a turn that’s running keeps what it started with.

## Expected functionality

- Lists personas, one picked, each with its version, its host and what it does on lines of their own, and “mock” after the name of each that runs on the mock (#12). The list’s bar is at the right end of the “Personas” heading’s row, above the list (#1735): + (New agent), − (Delete…), Edit, and Retire or Bring back, each naming the pick. Enter or a double click on a row opens its editor. The editor ([screenshot](../../screenshots/settings-persona-editor.png)) changes description, instructions, runs on, model, effort (#60), permissions (Auto (the harness judges) or Run everything), folder and tools, with Save, Retire and Delete… pinned under it, and “All personas” to go back. `/mode`, `/model` and `/effort` in the composer, and an agent’s name in the sidebar, open it.
- Under the list, “Start from a boilerplate” has one chip per boilerplate, built in or saved, in the New agent sheet’s order, except Blank: New agent beside it starts on Blank. A chip opens the [New agent sheet](../new-agent.md) with that boilerplate chosen, over Settings; closing the sheet puts focus back on the chip, and creating the agent closes Settings too. A boilerplate whose backend isn’t on this computer is disabled, with its reason, as in the sheet (“GPT (Codex not on this computer)”). `npx playwright test boilerplate-row` checks it on a fresh install.
- For Claude Code, the editor also has “Uses your Claude Code setup” (on by default) and “Can publish outside Postbox” (off by default). Like permissions, they apply to the persona’s conversations from their next turn. `npx playwright test persona-setup` checks both.
- Delete… asks once, says what goes and that it can’t be undone, then the persona goes at once, with its sessions and its memory.
- Under them, “MCP servers” lists your servers with their status from the persona’s latest turn, each with a checkbox, on by default. A server turned off doesn’t load for the persona, from its conversations’ next turn (#59). `npx playwright test runtime` (`tests/browser/runtime.spec.mjs`) checks the list, the keyboard and saving.
- The sheet takes the full height the window gives it, and the MCP servers and skills, which come a moment after it opens, fill in inside it: nothing moves under the pointer when they do, so Save stays where you aimed (#1326). A box in the sheet pressed the moment the pointer reaches it stays under the press too, in Safari as well, which has no scroll anchoring of its own (#1632). `npx playwright test sheet-hold-still` checks both, with both lists held back.
- On Claude Code, Tools are enforced: an unticked tool is turned off, and a ticked one still follows its permissions. Like permissions, changes reach the persona’s conversations from their next turn, and the save confirmation says so (#5).
- For a saved Claude Code persona, Permissions… opens the [permissions panel](../../shell/permissions-panel.md) over the editor, with its rules in the folder of its latest conversation (#66). Escape closes the panel and keeps the editor.

## Steps to reproduce

1. Run Postbox with Claude Code (`node server/index.mjs --port 4181 --data /tmp/pb-uat-personas --fresh`) and open <http://127.0.0.1:4181/>. Start a conversation with an agent on Claude Code and send it a message.
2. Click its name in the sidebar: this sheet opens on it. Edit its effort to High and save.
3. Send it another message.

**Pass if:** The save confirmation says it applies from its next turn in every conversation; the next turn runs at high effort, and the row under its name says so once that turn has run.
