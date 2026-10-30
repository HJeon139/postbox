# Requested call line

**Where:** In the conversation, in the agent’s turn, when a call it needed permission for ran because you’d asked for it.

## Why it exists

You approved a push or a PR in a confirm or a review block, and the agent’s `gh pr create` then asked you again on a permission card, for the same call. In one room that happened at least seven times in three days, and Always allow didn’t help: each PR had its own title ([#296](https://github.com/HJeon139/postbox/issues/296)). Claude Code’s auto mode already lets through what your message directly asks for, but a call that comes to Postbox’s card never got that judgment. Now it does, and this line says so, so nothing runs on your request without you seeing why.

## Expected functionality

- For an agent in Auto, a call that comes to Postbox (one of Postbox’s ask rules for writes outside it, or one of your own ask rules) first goes to a quick check: one Haiku call that reads what started this turn and the exact call. What started the turn is your message, or the confirm or review you approved, never another agent’s message. When your words directly ask for this call, it runs without a card.
- The check quotes your words, and Postbox makes sure the quote is in what you wrote or approved. A quote that isn’t yours is a card.
- Postbox keeps limits the check can’t lift:
  - A call that deletes, removes, merges, closes, archives, forces or runs as root always gets the card. That holds for a command anywhere in it, including inside a `$( )`, and for a tool by the words of its name.
  - Five calls a turn at most. The sixth gets the card.
  - A timeout, an error, or an answer it can’t read gets the card.
  - So does Ask me mode, a host’s agent, and a persona with the setting off.
- Each call that runs leaves a line: “Ran `gh pr create --title …` for @now without a card: you confirmed ‘Push 2d7c9a65’”, or “… you asked: ‘open the PR’”.
- **Stop these calls** ends that turn’s request. The line says “· Stopped”, a line in your voice says “Stopped: @now’s next call asks you first”, and its next call gets the card.
- The persona’s Permissions panel turns it off: “Calls you asked for run without a card”, on by default.
- The check’s cost is recorded with the turn (`judgeCostUsd` on its Work entry).
- The button works by keyboard, and the line reads the same without color.

## Steps to reproduce

1. Run `npx playwright test requested-calls` (`tests/browser/requested-calls.spec.mjs`). It confirms a block, sees the call run with its line and no card, presses Stop, sees the next call get a card, and turns the setting off in the panel. It should pass.
2. With a real agent and nothing leaving this computer, use `tally`, a ticket tracker that exists only for tests (`tools/tally/`):
   1. Start its server: `node tools/tally/server.mjs --port 4591 --log /tmp/tally.jsonl`.
   2. Make a scratch project folder with `.claude/settings.json` holding `{ "permissions": { "ask": ["Bash(tally:*)"] } }`, so each `tally` call comes to Postbox.
   3. Start Postbox with `tally` on the path: `PATH="$PWD/tools/tally/bin:$PATH" node server/index.mjs --port 4181 --data /tmp/pb-uat-tally --fresh`. Claude Code must be installed and signed in.
   4. Add the scratch folder as a project, and a Claude Code agent in Auto.
3. Send: “Create a tally ticket titled ‘Search misses plurals’ with a one-line body.” Then: “Delete ticket 1.”
4. Ask it to show a confirm block naming a ticket it will create, confirm it, and let it create the ticket.

**Pass if:**
- The first ticket and the confirmed one are created with no permission card, each with its line. `/tmp/tally.jsonl` shows each `POST /tickets`.
- The delete gets a card, and the log has no `DELETE` unless you allowed it.
- A message that asks for something else (“Look at ticket 1”) and then a create gets a card for the create.

## Related

- [Permission card](permission-card.md)
- [Permissions panel](../../shell/permissions-panel.md)
