# The ATIF exporter’s recorded run: `dry-run/`

`events.jsonl` and `live.jsonl` are what the UAT kit’s own recorder (`followEvents` and `writeHistory` in `tools/uat/history.mjs`) kept of one Postbox server’s `/api/stream`, recorded on 19 November 2026 at Postbox 4.34.1 plus the run clock (`server/run-clock.mjs`) and steps that name their tool (`server/harness-tools.mjs`). It was recorded again after hydrant-critic’s review, with a second agent. Nothing in them was edited.

How it was recorded:
- A real Postbox server (`start()` from `server/index.mjs`, its own port and data folder), with two agents, `@dry` and `@dry2`, on the Claude Code adapter. Each message names one of them; one goes to `@dry2` alone, so it never reaches `@dry`’s inbox.
- `POSTBOX_CLAUDE_BIN` pointed at a stand-in CLI with no model: for each turn it read the prompt Postbox sent, waited, then wrote back, line by line, a Claude Code stream recorded on claude 2.1.296 and kept in this repo. Turn 1 replays `tests/fixtures/claude-code/model-effort.jsonl` (one Bash call, priced), and turn 2 `block.jsonl` (its result has no cost). Turn 3 asked it to work until stopped.
- A 30 s run clock on `@dry`, started through `POST /api/sessions/:id/clock` with the page’s token, expired during turn 3, and Postbox stopped it.

So the events are Postbox’s own, and the agent’s side is a replay of recorded streams. The Claude Code lines carry their own timestamps from 22 October 2026, the day they were recorded: a test checks that no step’s time comes from them.
