# Codex app-server recordings

Where a recording here was made, and what was taken out of it. The rules every fixture follows are in `tests/fixtures/README.md`.

## `compact-continue.jsonl`

One `codex app-server` session, codex-cli 0.167.0, recorded on 27 November 2026 for #425, in a fresh temp folder with a read-only sandbox and approvals set to `never`. `tests/codex-compact.test.mjs` replays it to show that a Codex thread goes on after `/compact`.

### What the driver did

A small Node script started the app-server, spoke to it over stdio, and stopped the process it started at the end. In order, it sent:
1. `initialize`, then `thread/start`.
2. A turn, “Remember the word heron. Reply with just OK.” Codex answered “OK”.
3. `thread/compact/start` on that thread. Codex ran it as a turn with one `contextCompaction` item.
4. A turn on the same thread, “What word did I ask you to remember? Reply with just the word.” Codex answered “heron”.

### How MCP servers were kept off

`compact.jsonl`’s session started this computer’s own MCP servers, because `-c mcp_servers={}` didn’t clear them (PR #1807). This one started none:
- The app-server ran with `--disable plugins --disable apps`, which turns off plugin servers and Codex’s built-in apps server.
- For each `[mcp_servers.<name>]` header in Codex’s `config.toml`, it added `-c mcp_servers.<name>.enabled=false`. The driver read the names from the headers alone, and copied no login and no other setting. Codex’s own sign-in was used as it is.
- The driver’s pattern for those headers skips a name that contains a dot or a quote, so such a server would not have been turned off. Its guard covers that case: after `thread/start` it waited 4 seconds, counting `mcpServer/startupStatus/updated` notices, and would have stopped before any model call had it seen one. It saw 0, and the whole session had none.

### What was dropped and replaced

The file keeps 34 of the 39 lines the server sent.
- **Dropped:** `account/updated` (the sign-in mode and plan), every `account/rateLimits/updated` (the account’s usage), and `remoteControl/status/changed` (the computer’s name and an installation id). No test reads them.
- **Replaced:**
  - the thread id with `thr-1`, the three turns’ ids with `turn-1` to `turn-3`, and the item ids (the user messages, the agent messages and the compaction) with `id-1` to `id-5`, each the same wherever it appears;
  - the temp folder with `/work`, and the home folder with `/home`;
  - `instructionSources` with an empty list;
  - the user agent’s operating system version and terminal, as in `compact.jsonl`;
  - the local time in the rollout file’s name, as below.
- **Kept:** both user messages, the agent’s words (“OK”, and “heron” in two deltas), the model’s name, the timestamps and the token counts.

`checkFilePrivacy` in `tools/privacy-check.mjs` finds nothing in the file as committed, and in a copy it caught each planted string: a macOS home path, a Linux home path and an email address.

## `compact-resume.jsonl`

The second part of the same recording, made the same day for #425: a new `codex app-server` process, codex-cli 0.167.0, that resumes the thread `compact-continue.jsonl` compacted. Postbox starts a new app-server for each turn, so its turn after `/compact` resumes the thread in a new process, which the first part, all in one process, didn’t show. `tests/codex-compact.test.mjs` replays it as that turn.

### What the driver did

A second small Node script started the app-server with the same guards as the first part: `--disable plugins --disable apps`, each `config.toml` server turned off by name, a read-only sandbox and approvals set to `never`. It waited 4 seconds after the resume, counting MCP startup notices, and saw 0; the whole session had none. In order, it sent:
1. `initialize`.
2. `thread/resume` on the compacted thread. Codex answered with the thread and its 3 turns: the first turn, the compaction and the turn after it.
3. A turn, “What word did I ask you to remember? Reply with just the word.” Codex answered “heron”.

The driver sent `thread/resume` without `excludeTurns`, so the answer holds the thread’s history, and Codex sent a `deprecationNotice` about it. Postbox asks with `excludeTurns: true` (#1705), so its answer would have no history; the turn reads only the thread’s id and model from it.

### What was dropped and replaced

The file keeps 16 of the 21 lines the server sent.
- **Dropped:** `account/updated`, `account/rateLimits/updated` and `remoteControl/status/changed`, as in the first part; `deprecationNotice`, Codex’s note about full-history hydration; and `thread/goal/cleared`, which Postbox doesn’t read. No test reads them.
- **Replaced:**
  - the thread id with `thr-1`, and its first three turns and their items with the same `turn-1` to `turn-3` and `id-1` to `id-5` as in `compact-continue.jsonl`, matched by the real ids in the first part’s stream. The new turn is `turn-4`, and its user message and agent message are `id-6` and `id-7`;
  - both temp folders (the thread’s first one, and this process’s) with `/work`, and the home folder with `/home`;
  - `instructionSources` with an empty list;
  - the user agent’s operating system version and terminal;
  - the local time in the rollout file’s name, as below.
- **Kept:** the resumed thread’s history, the user message, the agent’s words (“heron”, in two deltas), the model’s name, the timestamps and the token counts.

`checkFilePrivacy` finds nothing in the file as committed, and in a copy it caught each planted string: a macOS home path, a Linux home path and an email address.

## The rollout file’s name

Codex names a thread’s rollout file for the local time it started, as in `rollout-<date>T<hh-mm-ss>-<thread id>.jsonl`, while every other time in a recording, such as `createdAt`, is in UTC. Side by side they give away the computer’s time zone. In every Codex fixture (this folder and `tests/fixtures/delivery-routes/codex-turn-steer.jsonl`), the time in that name is `00-00-00`, as in `/home/.codex/sessions/2026/11/27/rollout-2026-11-27T00-00-00-thr-1.jsonl`. The date stays: in the three `compact` recordings it’s also the UTC date of its `createdAt`. No other field in the three holds a local time: the rest are Unix times.
