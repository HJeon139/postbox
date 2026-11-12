# Showcase recordings

Five real sessions, recorded once with real agents and replayed by the demo’s mock for free: `node tools/demo.mjs --story showcase`, and the README’s GIF (`tools/readme-gif.mjs`). The mock plays them from `server/adapters/mock-showcase.mjs`; `tests/browser/demo-showcase.spec.mjs` plays each one. None of this folder ships in the npm package.

## How they were made

Each is one room in a Postbox started from this repository (`node server/index.mjs --port <port> --data <a fresh temporary folder>`) on 12 November 2026, with two agents:

| Agent    | Harness                                                    | Model                                               | Permission mode                                          |
| -------- | ---------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| @builder | Claude Code 2.1.318                                        | `claude-opus-5-5`, effort medium                    | Auto, with every turn capped at $4 by `--max-budget-usd` |
| @critic  | Codex 0.167.0 (`codex app-server`, signed in with ChatGPT) | `gpt-6.1-sol`, the first model `model/list` offered | Auto                                                     |

The person wrote one message in each room, the question below, and nothing after it. @builder answered with an app and asked @critic to review it; @critic read the app’s file and pinned comments to its parts with `review_block`; @builder shipped v2 with `update_app` and resolved each comment. A script drove the rooms through Postbox’s own API, with a browser page open on each so the apps were checked before they were shown. `view_app` used the headless Chromium Playwright had already installed on that computer, copied into the data folder, so nothing was downloaded.

Every agent worked in a temporary folder outside any git repository, and was told to make no git commits or pushes, no `gh` calls and no network calls.

Each `story.json` keeps the room as it was: the question, every real turn with its words, the app versions it made, its cost and tokens (`recordedTurns`), and the app’s code at the two versions the replay shows.

The replay plays three of those real turns, by this rule: @builder’s turn that handed the app to @critic, @critic’s first review, and @builder’s first turn that started after that review. Each says that turn’s words, shows the last version that turn made, and reports that turn’s recorded cost. Every other real turn is named in the story’s `notReplayed`, and listed below with what it cost. `tests/browser/demo-showcase.spec.mjs` checks the rule, the words, the versions and the costs.

## What the replay changes

Step labels that named a folder on the recording computer are left out. Apart from that, the replay changes only these, each also in the story’s `edits`:
- **`review` app, both versions:** the commit’s author line from `git show` showed a real name and email. Both are replaced with `Postbox maintainer <maintainer@example.com>`.
- **Every recording:** the review block’s fallback, which shows only where the block can’t be drawn, is “Review of [its title]: comment in the chat.” instead of the last real turn’s.
- **Titles:** where the review block’s title named a version the replay isn’t showing, that number is dropped there:
  - `raft`: “(v5)” is dropped while it shows v4.
  - `review`: “— v3” is dropped while it shows v2.
  - `elements`: “, v5” is dropped in both turns, since the replay shows v1 and v4.

Nothing else the agents wrote or built is changed.

## The recordings

Costs are what Claude Code reported for @builder’s turns, for the whole room; the turns the replay leaves out are in the last column. Codex reports no dollar cost for a ChatGPT sign-in, so @critic’s turns show none; they used that plan’s allowance.

| Folder     | Form                                   | The person’s question, in short                                              | App versions replayed | @critic’s comments       | Attempts | Cost of the kept run | Real turns not replayed                      |
| ---------- | -------------------------------------- | ---------------------------------------------------------------------------- | --------------------- | ------------------------ | -------- | -------------------- | -------------------------------------------- |
| `raft`     | A simulation to poke                   | How does Raft stay consistent when the leader dies mid-write?                | v4 → v5               | 4                        | 2        | $1.87                | @builder, $0.11                              |
| `elements` | A real-data explorer with linked views | How do the periodic table’s properties relate? All 118 elements, embedded    | v1 → v4               | 5 of 8, over two reviews | 2        | $1.86                | @critic, no dollar cost; @builder, v5, $0.25 |
| `capacity` | A decision model                       | How many GPU replicas keep p99 wait under 500 ms at 40 requests a second?    | v3 → v7               | 4                        | 2        | $1.10                | @builder, v4–v5, $0.24                       |
| `review`   | A code review surface                  | Review commit 9927123c, which caps the items route, with its caps as handles | v2 → v3               | 5                        | 2        | $0.90                | @builder, $0.04                              |
| `deps`     | A network picture                      | Postbox’s own module graph, from `server/` and `app/js/`                     | v9 → v11              | 4                        | 3        | $2.90                | @builder, $0.06; @builder, $0.09             |

The full question is each story’s `ask`. The `review` room’s folder held `git show 9927123c` as a patch file, and the `deps` room’s a copy of this repository’s `server/` and `app/js/` source files.

## Attempts, and what they cost

- **First attempt, every room: $12.91, discarded.** The fresh data folder already had a `@critic` on Claude Code, so the script’s Codex critic was never made, and both agents ran on Claude Code. The loop worked, but it wasn’t cross-vendor.
- **Second attempt, every room: $7.44, four kept.** @critic moved to Codex. These rooms ran in the first attempt’s folders, so @builder could read, and built on, its own app file from the first attempt.
- **`deps`, third attempt: $2.90, kept.** The second attempt’s graph was mostly lists of modules in pills rather than a picture. It ran again in a fresh folder, with a question that asked for one network of every module.

In all, the agents spent $23.25 on Claude Code, under the $40 the owner approved.
