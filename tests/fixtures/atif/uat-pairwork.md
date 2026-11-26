# The ATIF exporter’s recorded streams: `uat-pairwork/`

From `tools/uat-run.mjs`’s run `2026-11-26T07-51-40-pairwork` on 26 November 2026 at commit a8df57c2, with two real Claude Code agents, `@developer` and `@critic`, and the run’s `POSTBOX_CLAUDE_RECORD` streams (#1758, #1752).
- `events.jsonl` is the run’s `/api/stream` recording (`tools/uat/history.mjs`, `writeHistory`), as it was, except that the home folder reads `/home/user`, the user’s name `user`, and macOS’s per-user temporary folders `/tmp`.
- `streams/` holds the run’s Claude Code turn streams, one file per turn, named as the run named them (`<started>-<handle>.jsonl`). Only their `assistant` lines with a `tool_use` and `user` lines with a `tool_result` are kept, with the same three names replaced. A turn whose stream had neither is left out, so 9 of its 15 files are here.

The kept lines are whole otherwise, so they still carry the API’s own identifiers: each request’s and message’s id, the CLI’s session id and uuids, and the usage figures. None is a credential.

The streams hold 17 calls, and a trajectory built from the conversation’s steps alone has 10. The 7 left out made no step: four `mcp__postbox__react`, two `read_message` and one `read_conversation`. Three of the developer’s turns made only such calls, so no step shares their ids.

The run’s `live.jsonl`, `prompts.jsonl` and blobs aren’t here, so the trajectories say they were built without prompts and give no stored outputs.
