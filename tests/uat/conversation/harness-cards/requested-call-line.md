# Requested call line

**Where:** In the conversation, in the agent’s turn, when a write outside Postbox ran without a card because you’d asked for it.

## Why it exists

You approved a push or a PR, and the agent’s `gh pr create` then asked you again on a permission card, for the same call. In one room that happened at least seven times in three days, and Always allow didn’t help: each PR had its own title ([#296](https://github.com/HJeon139/postbox/issues/296)). Now a write you asked for runs, and this line says so, with the whole call, so nothing runs on your request without you seeing what and why.

## Expected functionality

- **Which calls:** only a call that comes to Postbox through its own rules for writes outside (MCP tools named for writing, `gh` writes), for an agent in Auto. A call your own ask rule caught, a host’s agent, a subagent, and Ask me mode always get the card.
- **A confirm you confirmed** lets a command through when its statement shows that exact command in code, word for word, as it runs. No model is asked. A review approves a draft’s text, not a call, so it doesn’t count by itself, and neither does a confirm you declined.
- **Your typed words** that started the turn let a call through when a quick check by Claude Haiku finds they ask for it. The check quotes you, and Postbox makes sure the quote is two or more whole words you typed, with no “don’t”, “never” or “not” in its sentence, and shares a word with the call itself, not with a title or a body the agent wrote. A call one of your own ask rules covers keeps its card. A block’s words are the agent’s, so they’re never quoted. The check sends the call and your message to Anthropic.
- **Limits Postbox keeps in code,** whatever you asked:
  - Only these can pass: a plain `git push [remote] [branch]`, and git commands with only the flags listed for them; `gh pr|issue create`, `comment` and `edit`, on the project’s own repository or one you named, and a comment or an edit only on an item this conversation made or you named; commands that only read files in the project, and never a hidden file such as `.env`; a title or a body with no `$variable` or command in it; and MCP tools whose names create, add, edit, update, comment, post, append, reply or write, with only text, a PR’s branches, and a repository or an item you named in their input.
  - Everything else asks, wherever it appears in a command, including inside a `$( )`: deletes, merges, force pushes, `+` or `:` refspecs, labels, locks, settings, secrets, `gh api`, a shell or an interpreter, a redirect, a `VAR=value`, an alias.
  - A git command also asks when the repository’s git config changes what it does or runs a program, when a git hook would run, or when a push goes to a remote other than `origin` or one you named, or to a branch you didn’t name other than the one checked out (never the default branch).
  - Five calls a turn at most. A timeout, an error, or an answer the check can’t read gets the card.
- Each call that runs leaves a line: “Ran `gh pr create --title …` for @now without a card: you confirmed ‘Push 2d7c9a65’”, or “… you asked: ‘open the PR’”. **The whole call** opens the call as it ran.
- **Stop these calls** ends that turn’s request. The line says “· Stopped”, a line in your voice says “Stopped: @now’s next call asks you first”, and its next call gets the card.
- The persona’s Permissions panel turns it off: “Writes you asked for run without a card”, on by default.
- The check’s cost is recorded with the turn (`judgeCostUsd` on its Work entry).
- Every control works by keyboard, and the line reads the same without color.

## Steps to reproduce

1. Run `npx playwright test requested-calls` (`tests/browser/requested-calls.spec.mjs`). It confirms a confirm that shows two commands, sees the first run with its line, the whole call and no card, presses Stop, sees the second get a card, and turns the setting off in the panel. It should pass.
2. With a real agent and nothing leaving this computer, use tally, a ticket tracker that exists only for tests (`tools/tally/`):
   1. Start its server: `node tools/tally/server.mjs --port 4591 --log /tmp/tally.jsonl`.
   2. Make a scratch project folder with a `.mcp.json` that runs `node <this clone>/tools/tally/mcp.mjs` as the `tally` server, and a `.claude/settings.local.json` with `{ "enabledMcpjsonServers": ["tally"] }`. Its tools (`create_ticket`, `add_ticket_comment`, `edit_ticket`, `delete_ticket`) match Postbox’s rules for writes outside.
   3. Start Postbox: `node server/index.mjs --port 4181 --data /tmp/pb-uat-tally --fresh`. Claude Code must be installed and signed in. Add the scratch folder as a project, and a Claude Code agent in Auto.
3. Send: “Create a tally ticket titled ‘Search misses plurals’ with a one-line body, right away, no draft.” Then: “Delete ticket 1.”
4. Send: “Thanks, looks good. Can you check the README?”, and see that any ticket the agent then creates gets a card.

**Pass if:**
- The first ticket is created with no permission card, with its line quoting your words. `/tmp/tally.jsonl` shows its `POST /tickets`.
- The delete gets a card, and the log has no `DELETE` unless you allowed it.
- A create after a message that doesn’t ask for one gets a card.

## Related

- [Permission card](permission-card.md)
- [Permissions panel](../../shell/permissions-panel.md)
