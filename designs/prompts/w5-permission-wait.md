# Prompt: wave 5, a permission card that waits (#217)

A wave 5 session, small and first to merge. The triage session integrates it, and the architectural review session reviews it. Follow [README.md](README.md) for the rules every session shares. Your ports are 5050–5099 for servers and 10350–10399 for Chrome.

---

You’re making a permission card wait for the person as long as they take, on the branch `fix/w5-permission-wait`, in one pull request with one commit.

## Why

A permission card is how the person stays in charge of what an agent does (intent.md, principle 6), and it’s often answered minutes later.
- With the Claude Code CLI backend, Claude Code asks by calling Postbox’s MCP tool `permission_prompt` (`--permission-prompt-tool mcp__postbox__permission_prompt`), and Postbox answers the call when the person answers the card.
- Postbox’s server reaches `--mcp-config` as `{ type: 'http', url, alwaysLoad: true }` with no `timeout` (`postboxServer`, `server/adapters/setup.mjs:48`). Claude Code gives an HTTP server’s request 60 seconds to its first byte.
- So a card left for over a minute fails. The agent gets “The operation timed out” and may retry, and the card answered later goes nowhere.
- #217 has a repro on Claude Code 2.1.308. With no `timeout`, the call was cut at 60.0 s, twice, and the command never ran. With `"timeout": 900000`, it was still waiting at 8 min 44 s.

## Read first

- [README.md](README.md); #217; `designs/intent.md`, the permission rows.
- `postboxServer` in `server/adapters/setup.mjs`, and where `claude-code.mjs` and `agent-sdk.mjs` use it. The Agent SDK asks through `canUseTool`, so it isn’t affected, but it shares the config.
- Kiro’s MCP config (`server/adapters/kiro-cli.mjs:195`) has no timeout either.
- Claude Code’s docs on MCP time limits, which #217 cites.

## The work

- Set the per-server `timeout` on Postbox’s server, long enough for a day’s wait plus a margin, as #217 proposes (25 hours). Say why in a comment beside it.
- Check the CLI’s own idle window, which #217 says the `timeout` also sets a floor under. Record it in the pull request.
- Kiro: find out from its documentation or a repro whether it has the same limit. Fix it the same way if it does. If you can’t tell without a Kiro run (a `--compat` run, which you don’t start), say so in the pull request.

## Files

- **Yours:** `postboxServer` in `server/adapters/setup.mjs`, Kiro’s MCP config line in `server/adapters/kiro-cli.mjs` if it needs it, and their tests.
- **Shared:** none.

## Done when

- A test checks that the config Postbox passes to Claude Code has the `timeout`, and fails without it.
- No live repro is needed, since #217 has one. Don’t start an agent turn to make another.
