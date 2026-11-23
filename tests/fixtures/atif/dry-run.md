# The ATIF exporter’s recorded run: `dry-run/`

`events.jsonl` and `live.jsonl` are what the UAT kit’s own recorder (`followEvents` and `writeHistory` in `tools/uat/history.mjs`) kept of one Postbox server’s `/api/stream`, recorded on 19 November 2026 at Postbox 4.34.1 plus the run clock (#1526) and steps that name their tool (#1527). It was recorded again after review: with a second agent, and then once each turn’s prompt was recorded.

`prompts.jsonl` is that recording’s prompts, in the file #1528 writes instead (`server/turn-prompt.mjs`; its rows are in `tests/uat/e2e/README.md`). The recording had them as events in the stream, `turn.guide { sha, text, at }` and `turn.prompt { sessionId, turnId, threadId, guideSha, text, at }`, as #1522 recorded them before they moved out of the store. On 21 November 2026 those 6 events were taken out of `events.jsonl`, in order, and written as `prompts.jsonl`’s rows: each `turn.prompt` as a `prompt` row with the same fields, and each `turn.guide` as a `guide` row with the `sessionId` of the prompts that name it. No text was changed: each row’s `text` is the event’s, byte for byte. Nothing else in the files was edited. A real run keeps `prompts.jsonl` in its `data/` folder; here it sits beside `events.jsonl`, since `.gitignore` leaves out every `data/`, and the exporter reads either.

How it was recorded:
- A real Postbox server (`start()` from `server/index.mjs`, its own port and data folder), with two agents, `@dry` and `@dry2`, on the Claude Code adapter. Each message names one of them; one goes to `@dry2` alone, so it never reaches `@dry`’s inbox.
- `POSTBOX_CLAUDE_BIN` pointed at a stand-in CLI with no model: for each turn it read the prompt Postbox sent on stdin and the guide in `--append-system-prompt`, logged both, waited, then wrote back, line by line, a Claude Code stream recorded on claude 2.1.296 and kept in this repo. Turn 1 replays `tests/fixtures/claude-code/model-effort.jsonl` (one Bash call, priced), and turn 2 `block.jsonl` (its result has no cost). Turn 3 asked it to work until stopped.
- A 30 s run clock on `@dry`, started through `POST /api/sessions/:id/clock` with the page’s token, expired during turn 3, and Postbox stopped it.

So the events are Postbox’s own, and the agent’s side is a replay of recorded streams. The Claude Code lines carry their own timestamps from 22 October 2026, the day they were recorded: a test checks that no step’s time comes from them.

In the last recording, the four prompts and two guides the stand-in CLI logged matched the recorded `turn.prompt` and `turn.guide` events byte for byte, and so `prompts.jsonl`’s rows.
