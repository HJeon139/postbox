# Running Postbox

Installing and running Postbox: the package, its flags, the data folder, the `POSTBOX_*` settings, upgrades, the demo, versions and what it can’t do yet.

## Run it

Postbox needs Node 22 or later. It runs with no dependencies at all. From a clone:

```bash
npm start
```

**As a package.** Postbox isn’t published to npm yet, so pack it from a clone and install the file it makes, which gives you a `postbox` command:

```bash
npm pack
```

```bash
npm install -g ./postbox-<version>.tgz
```

```bash
postbox
```

A global install brings the optional packages too (the Agent SDK and Kokoro, several hundred MB); add `--omit=optional` to a project install to leave them out. `postbox --help` lists its flags: `--port`, `--data`, `--fresh`, `--demo`, `--move-data`, `-v` (`--version`) and `-h` (`--help`). The package holds only what runs (`bin/`, `app/`, `server/`, `shared/` and `agent-plugin/`, the skills Postbox gives its agents) and `CHANGELOG.md`, and its build line under **Personas** shows the commit it was packed from. Upgrading or uninstalling it leaves your conversations alone, since they’re in `~/.postbox`, not in the package.

Open <http://127.0.0.1:4173/>. Postbox listens only on this machine. Your conversations are kept in `~/.postbox` as an event log, so they survive a restart and an upgrade. Set `POSTBOX_HOME` to keep them somewhere else, or pass `--data <folder>` for one run. Add `--fresh` to start over.

**Agents waking agents.** After 1,000 agent wakes in a row without your message, the next waits for your Allow, as a backstop against agents that never stop. A room sets its own limit, from 1 to 10,000, in its menu (⋯ › Wake chain limit…); a room without one uses the server’s default, which `POSTBOX_CHAIN_LIMIT` sets, a whole number from 1 to 10,000 (#1035).

**A clone that ran an earlier version.** Earlier versions kept everything in the clone’s `data/` folder. A clone whose `data/` has conversations keeps using it, unless `POSTBOX_HOME` is set, and says so when it starts. To move it to `~/.postbox`, stop Postbox and run `npm start -- --move-data`: it moves the folder and leaves a link in its place, so paths your conversations recorded still work. An agent that works in its own workspace folder starts a new Claude Code session on its next turn, since its folder moved; its conversation in Postbox stays. Postbox never moves it without being asked.

One Postbox runs on a data folder at a time: a second one on the same folder refuses to start, and says which process has it.

A fresh install starts with three general-purpose agents and no projects or conversations: @researcher finds and cites sources, @developer changes code and verifies it, and @critic reviews code and documents. Their instructions are in [`server/personas/`](../server/personas/). Make a project for a folder you work in, start a conversation with any of them, and add agents of your own from **New agent**. They run on Claude Code if it’s installed and signed in (`claude --version` works), and on the mock otherwise. Agents from an earlier run keep their backend; change it under **Personas**, in **Runs on**.

To start with agents of your own instead, put an `agents.json` in the data folder before the first run: an array of personas such as `[{ "handle": "reviewer", "description": "Reviews my drafts.", "instructions": "…" }]`. It replaces the seeded agents, with or without `--demo`.

`--demo` seeds the demo’s reading-notes agents (@librarian, @indexer, @researcher and @critic), two projects and the sample conversations below, with a few short notes as the asset explorer’s and the shelf’s assets ([`server/demo-assets/`](../server/demo-assets/)), and always uses the mock, for the scripted tour. To use the Agent SDK, read aloud and run the development checks, install the optional packages once:

```bash
npm install
```

To watch the demo, which plays every block type and every error state on the mock (it starts its own Postbox in demo mode), run this and open the same address:

```bash
node tools/demo.mjs
```

Keep the page open while it plays: agent-written apps are checked in your browser before they’re shown.

Things to try in the demo’s conversations (`node server/index.mjs --demo --fresh --data data/demo`, which keeps them apart from your own):

| Conversation | Ask | You’ll see |
|---|---|---|
| Asset explorer | Build me an explorer for these assets | An agent-written app searching the conversation’s notes through the bridge, and a v2, filtered by asset, after you send passages |
| Catalog tour | Show me every kind of block you can send | One of each catalog block, all live |
| ReAct, step by step | Explain ReAct with something I can try · Walk me through ReAct, out loud · then **Reply in thread** under the explainer | Citations with hover cards, a diagram, math, a glossary term and a practice app · slides that follow a local voice · a topic thread, and Summarize back |
| Search schema spec | Review my search schema line by line | Markdown, code and app reviews, then a revision shown as a diff |
| Index the shelf | Index the shelf · Rebuild without the prefaces · Show it as a timeline · Show me the shelf map · Show me a dashboard · Clear the old index cache · Draw the whole indexing pipeline | Progress, subagents and a compaction · a failed reply with Retry · blocks Postbox can’t show · a crashed app · an app that fails its check and gets fixed · a permission card · a diagram too wide to read, flagged by the diagram linter and redrawn |
| Index planning | @indexer check the editions with the researcher, in a loop | Agents waking each other in a side thread until the limit asks you |
| Citation fixes | Fix the citation script · then Try a faster parser · then **Work** in the top bar, and its full-screen icon | Every file the agent changed with its diff and a copy from before, flagged changes, the commands as they ran, an issue it filed, and a turn that left nothing lasting |

## Versions

Postbox uses [semantic versioning](https://semver.org/), from [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): a breaking change moves the major version, a feature the minor version, and a fix the patch version. The sidebar shows the running build under Personas, as `vX.Y.Z · commit`. Each release is in [CHANGELOG.md](../CHANGELOG.md), and the rules are in [designs/engineering-practices.md](engineering-practices.md), “Commits and versions”.

## Known limits

- **You can’t go back to a build before the `session.patch` event.** Once this version has written to your data folder, a build from before it (v0.44.x and earlier) won’t start: its reducer doesn’t know the `session.patch` event the log now holds, and it replays the log after the snapshot at every start. To run an older build, give it a copy of your data folder from before the upgrade, or a new folder with `--data`. Don’t start it with `--fresh` on your data folder: that deletes every conversation in it.
- **Each open tab holds one connection.** Browsers allow 6 connections per host over HTTP/1.1, so with about six Postbox tabs open, new requests wait. Postbox closes its stream when a tab is put away, but it doesn’t yet share one stream across tabs.
- **The pre-display check is approximate.** It finds overflow, missing labels and alt text, positive tabindex, low contrast and script errors. It doesn’t yet detect every keyboard trap or verify that saved state restores correctly.
- **Semantic search is a stub.** It uses a small table of related words until your own index is connected. Lexical search (BM25) is real.
- **There’s no sign-in.** Postbox is for one person on one machine, and it refuses requests from other hosts and other sites.
- **An attached session has two writers.** If you write to it from Postbox while a terminal turn is still running, both resume the same session. Postbox can’t see that a terminal is busy.
- **Each Claude Code turn starts a new process.** Resuming a session adds a second or two before the first token. A long-lived process per session would remove it.
- **Kokoro’s dependencies have open advisories** (`sharp`, and `sprintf-js` through `onnxruntime-node`) with no fixed versions yet. They run only in the narration process, never in the server.
- **There’s no search across threads yet.**
- **Remote hosts are Linux only.** Postbox needs a Linux host with `/proc`, and relies on the boot ID there. It uses systemd only when **How turns detach** is left on its default (`detach` is `auto`) and logind kills user processes at logout; “Own session only” works without systemd.
- **A Kiro agent’s messages on a host can be read by other users there,** since Kiro CLI takes its message as an argument and `/proc` shows every process’s arguments unless it’s mounted with `hidepid=1` or higher; the default is `0` ([proc(5)](https://man7.org/linux/man-pages/man5/proc.5.html)). Postbox doesn’t check the mount, so it warns on every remote Kiro turn.
- **Files you attach for an agent on a host are limited to 3 MB each and 3.5 MB per message,** since they go to the host with the turn; a message over either is refused before the turn starts. The host’s copy is deleted when the turn ends, so a later turn can’t read it again: attach it again.
- **A host you can’t reach can’t be forgotten yet.** Remove waits for the host to confirm it deleted `~/.postbox-remote`, and there’s no “forget it anyway”.
- **Only Claude Code’s sign-in expiry is recognized on a host.** A Kiro CLI or Codex turn whose sign-in there ran out fails as an ordinary error, not as Sign-in needed with Resume.
- **`!` commands run on this computer,** even in a conversation whose agent runs on a host.
