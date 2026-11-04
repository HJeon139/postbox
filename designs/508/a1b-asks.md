# A1b: asks derived from the cards, the first private key, and #608’s findings

**Status:** the design for #508’s A1b, approved by the maintainer after the reviewer’s reads and security go (#711). Every citation was read at `main` `48f20ccd` unless it names another head. Its code is not built yet: it starts from #633, now merged, and lands in its own PRs, each of which repeats §4’s sweep on its own head.

**Where it departs from `design.md`:** asks are derived from the open cards rather than stored as `ask` records (D1), and the one record kind A1b adds, the hold, lives outside `state` (D13). Where `design.md` says otherwise for A1 (`:133`, `:196`, `:562`), this note decides.

**Intent and requirements:** one person directing two to four agents, with the loop right before the looks (`designs/intent.md`). This note serves #508’s A1 (`designs/508/design.md:607`): one owner for ask state and `card.held`, from which needs-you and open asks are derived. It carries the integrator’s #608 findings (#608, issuecomment-6554665567, and its reply) and #366’s and #594’s cases.

## 1. Decisions

D1–D9 were settled in grooming, D10 and D11 by the maintainer, and D12 and D13 in review.

| # | Decision | Why |
|---|---|---|
| D1 | **Asks are derived from the open card items, not stored as a second record.** | The integrator’s “smaller structural fix” on #608. A record beside the card’s `status` is a second source of truth that must be kept in step. It also keeps one copy of each message (the persistence review). |
| D2 | **A hold is a record:** `{ id, kind: 'hold', heldBy, cardId, waiting }`. It replaces `card.held`, as `design.md:607` says. The card item gets no new field. A1b owns only the hold. Sent attempts, dispatch, pins and routes stay A2’s. | `card.held` is a list on the card with no owner field (#594’s case: a held wake blocks an unrelated message). |
| D3 | **The first producer is the asking card:** a block or app-send card that waits on the person. | It’s #366’s case, and what #633’s `nextNeed` already orders, so the equivalence spec has one target. |
| D4 | **Private events:** a whole `record` event type with `public: false`, and `records` in `PRIVATE_STATE_KEYS` (`shared/state.mjs:98`, empty today). | A non-public event already goes out as a `cursor` frame (`server/live-streams.mjs:13–14`). |
| D5 | **Ties use code-unit order** (`a.id < b.id`), not `localeCompare`. | #608’s finding: `localeCompare` depends on the locale. |
| D6 | **Receipts are derived inside the reducer**, as `design.md` says (“Receipts”). | So the two designs don’t disagree. |
| D7 | **No `structuredClone` per command.** The reducer copies only the records a command touches: O(records touched). | #608 measured 16–25 ms at 4,096 records per command. |
| D8 | **A1b reads #633’s `lastTurnId` and `keptTurnIds`**, and keeps no copies. | #633’s body asks for this. |
| D9 | **Old builds:** see §5b. A downgrade drops the holds; held wakes then behave as on `main`. | `storage-design.md:388`, the `BREAKING CHANGE` rule. |
| D10 | **An agent’s own read tools may show the held state of its own asks**, never another agent’s records. **One limit:** while the agent’s host is offline, it can’t see that state (D12). | The agent should see what it’s waiting on. The privacy line runs between agents, and between the laptop and anything it hands out. |
| D11 | **The tie change ships in A1b’s first PR.** `needsOrder`’s `localeCompare` (`shared/needs.mjs:38`) becomes code-unit order in the same change as `asksOf`. | One PR changes the order once, with its equivalence spec. |
| D12 | **The host snapshot carries no records at all**, rather than records filtered per agent. | Every record kept off the remote machine is one less private key that can leak there. A per-agent slice for offline use would be a separate design. |
| D13 | **Records live outside `state`.** The store keeps `store.state`, public and the same as today, and `store.held`, which holds `records`. The reducer applies a `record` event to `store.held` only. On disk, `held` has its own file (§5b). | `rt.s` is a getter for `this.store.state` (`server/runtime.mjs:197–198`), and the server has 269 direct reads of `rt.s` or `store.state` across 64 files, some of them whole-object (`{ ...rt.s }` at `server/telemetry-report.mjs:42`). None of them can see a record, and neither can code not yet written. |

## 2. What exists today

- **No records module.** #608 (A1a) closed unmerged on 2 November, and #630 merged only the event table and the projection.
- **The event table:** `EVENTS` is at `shared/state.mjs:121–159`, and every event is public. `PUBLIC_STATE_KEYS` is at `:75–97`, and `PRIVATE_STATE_KEYS = []` at `:98`.
- **What reaches the page:** `/api/state` sends `publicState(store.state)` (`server/page-state.mjs:19`, `server/public-state.mjs:9–10`). The live stream sends public events, and a `cursor` frame for the rest (`server/live-streams.mjs:13–14`, `:38`, `:76`).
- **What reaches a host:** `snapshotOf` (`server/remote/turns-snapshot.mjs:23`) builds the snapshot a host turn reads. The host keeps it as `snapshot.json` (`server/remote/host/broker-snapshot.mjs`), and `broker-offline.mjs` answers the read tools from it while the laptop is unreachable.
- **The store on disk:** `snapshot.json` is `JSON.stringify(store.state)` (`server/store-snapshot.mjs:21`), loaded as `ownState({ ...emptyState(), ...parsed })` (`server/store-recover.mjs:62`), with no version check.
- **Routes:** `server/index.mjs` routes through a chain of 63 `path === …` and `path.match(…)` checks. There is no route table.
- **Needs today:** `se.needs` holds the one card the page shows. `waitedSince` and `needsOrder` (`shared/needs.mjs:25`, `:35–38`) read items. #633 (merged since) moves the decision into `server/card-needs.mjs` (`nextNeed`, `offerNeed`, `releaseNeed`), and its header calls `nextNeed` “the one function A1b replaces”.

## 3. The design

**Asks, in one function.** `askOf(item)` returns the ask for an open card item, or null. `asksOf(state, session)` reads the agent’s open card items and returns them in order (D5). `nextNeed` becomes `asksOf(...)[0]`. Every setter and clear still goes through #633’s three functions: A1b changes what they read, not who writes.

**Holds (D2, D13).** A hold is a record in `store.held.records`, keyed by its id. `holdsOf(held, cardId)` reads them. The card item is unchanged. The first PR adds no other record kind; each later one needs its reason here first.

**Who may read `store.held`.** Only these, enforced by a `lint-security` rule that fails on `.held` read anywhere else. The allowlist is in the lint, with a reason for each entry.
- `shared/records.mjs`;
- the reducer’s `apply` for `record`;
- the snapshot writer and loader (`store-snapshot.mjs`, `store-recover.mjs`, `store-replay.mjs`);
- Retry’s reload (`store-retry.mjs`);
- `ownAsks`.

`publicState` keeps its filter as a second guard, and a test asserts it never sees `records`.

**Cost.**
- `rt.s` is the same object as today, so no hot path changes.
- A `record` event writes one entry: O(1).
- A snapshot writes `held-<seq>.json` too: O(records), one more fsync and rename.
- `asksOf` replaces #633’s existing pass over the conversation’s items, so it adds no scan. With the store’s item index (#712’s peer read, and the persistence note) it becomes an index read. The spec times one call on the 10× generated room.
- `holdsOf` is O(holds on that card).

## 4. The first private key: every channel off the laptop

AGENTS.md says every route other than `/api/state` and the stream may carry only public keys, and that review holds that “until A1b adds a check with the first private key”. D13 is that check, by construction. This sweep lists every channel, and the canary test covers each one. The code PR repeats the sweep on its own head.

| Channel | Where | Why no record leaks |
|---|---|---|
| `/api/state` and the live stream | `page-state.mjs:19`, `live-streams.mjs` | read `store.state` (D13), and `publicState` filters as a second guard |
| Other routes, including the write routes’ return values | `server/index.mjs` and the route modules | built from `rt.s` (D13) |
| The host snapshot | `turns-snapshot.mjs:23` | built from `rt.s`, which holds no records (D12, D13) |
| The host’s offline answers | `broker-offline.mjs` | read only the snapshot |
| Telemetry reports and their `gh` issue | `telemetry-report.mjs:42`, `telemetry-file.mjs` | `{ ...rt.s }` holds no records (D13). The report also builds `state` from `publicState`, as a second guard |
| The apps’ query route | `index.mjs:437` → `rt.appQuery` | `appQuery` never calls `ownAsks`, so an app sees only what the page sees. D10 covers the agent’s own tool calls, not its apps |
| Prompts and catch-ups to the CLIs | `item-lines.mjs` (reads `rt.s.apps` at `:193`), `catch-up-keep.mjs`, `thread-summary.mjs`, `turns-prompts.mjs` | built from `rt.s` (D13) |
| Agents’ read tools on the laptop | MCP and host turns online: `read_conversation`, `read_message`, `list_assets` | only `ownAsks`, keyed on the session the call’s turn token resolves to (`mcp.mjs` checks the token), never on a session id from the tool’s arguments |
| Error and status text | `store-reject.mjs:34`, `rejected.first[]` | #632’s contract: a status line never quotes private fields (`609-reducer-throw.md:34`). The canary test forces it |
| The store on disk | `held-<seq>.json` and the event log | laptop-only, and `snapshot.json` holds no records (§5b). They’re never copied into a telemetry bundle or a UAT report, and a test asserts it |

**Routes, enumerated.** The code PR’s first commit is move-only: it extracts `server/index.mjs`’s route chain into a declared route table, `server/routes.mjs`, with each route’s method, pattern and handler, and nothing else changed. The canary test enumerates that table. A route in the table that the test doesn’t exercise fails the test.

**The canary test.** It seeds a hold record for agent A and one for agent B, each holding a canary string. It fails if either canary appears in any of these:
1. every route in the table, including each write route’s return value;
2. the stream and its backlog replay;
3. A’s host snapshot;
4. a telemetry report and the `gh` issue body, with `gh` stubbed to capture its arguments;
5. A’s app’s query results;
6. the prompt and catch-up text built for A’s turn and for B’s;
7. a reducer error forced while applying a record whose message carries the canary: the status line, `rejected.first[]`, `/api/state` and the stream;
8. `snapshot.json`.

It also fails if B’s canary appears in A’s laptop read tools, if a call with A’s token and B’s session id returns B’s records, or if A’s own canary is missing from A’s `read_message` of its card (D10).

It must fail first:
- with one record written into `store.state` instead of `store.held`;
- with the telemetry report built from the raw store;
- with `appQuery` calling `ownAsks`;
- with `ownAsks` returning every record;
- with `held` written into `snapshot.json`.

## 5. Invariants and the failure table

- **I1. One owner:** an open card item is the only source of its ask, and a hold record is the only source of its hold.
- **I2. A clear is its own** (#633’s I2): only the card’s resolver clears its need.
- **I3. Private stays private, by construction:** `store.state` and `snapshot.json` never hold a record (D13). A laptop read tool shows only the asking agent’s own (D10).
- **I4. Code-unit order** on every reader, `needsOrder` included (D11).
- **I5. The reducer never throws on a batch its builder accepts** (#632’s contract, `609-reducer-throw.md:33`).
- **I6. #608’s limits:** the open and reserve size limits agree; `revise` can’t change `askKind` or `deliveryId`; `release` and `block` can’t change `mode` or `notBefore`; a closed id can’t be opened again; a dangling `deliveryId` and unknown part fields are refused.
- **I7. A matched pair:** `held` is loaded only from the `held-<seq>.json` whose `seq` and `snapshotLength` match `snapshot.json`; otherwise it starts empty and the log rebuilds what it can.

| Step | On disk after a kill | A concurrent reader | The person |
|---|---|---|---|
| Card item written, need not yet set | the item, no need | `asksOf` already derives the ask from it | the card shows; the ring follows on the next derive |
| Hold record committed, held message not yet released | the hold | the held wake waits behind the card it names | “held” on the card once it’s read |
| A half-written event | never seen: one function-form commit (`store-commit.mjs:241`) | — | — |
| A snapshot, between its two renames | the old pair, plus an orphan `held-*.json` (§5b) | — | as before the snapshot |
| Store Retry after an outage | the reload rebuilds `state` and `held` together (§5b) | nothing activates before the derive commits | the same cards, re-derived |
| Restart | asks re-derived from items; #633’s sweep sets `se.needs` | — | as before |
| A host goes offline | the host’s `snapshot.json`, with no records | the host answers reads from it | the agent sees its cards, not their holds (D10’s limit) |

## 5b. Two state objects (D13): their own class table

**On disk.** `snapshot.json` stays exactly what it is on `main`: the state itself, top level. `held` gets its own file, `held-<seq>.json`, `{ seq, snapshotLength, records }`, where `seq` and `snapshotLength` are those of the snapshot it goes with. Nothing private is ever written into `snapshot.json`, so no build, older or newer, can load a record into `state`.

**Why not one `{ state, held }` document** (the reviewer’s finding): an older build loads the snapshot as `ownState({ ...emptyState(), ...JSON.parse(text) })` (`store-recover.mjs:62`). It would start with every map empty and two stray keys, `state` and `held`, and nothing refuses it. **Why not `held` as an extra top-level key:** an older build keeps the extra key in `rt.s`, and the UAT facts copy `{ ...rt.s }` (`telemetry-report.mjs:42`), so records would leave the laptop on a downgrade. **Why not a version bump:** no build on `main` reads `state.version` (`shared/state.mjs:17`) on load, so the builds already shipped wouldn’t refuse it.

**Snapshot order** (O(records) more per snapshot, one more fsync and rename). The rename of `snapshot.json` stays the single commit point: the held file is written and fsynced before it, so no loaded snapshot is ever missing its `held`.
1. Build the state’s text, then write `held-<S>.json` (temporary file, fsync, rename), where S is the snapshot’s seq and `snapshotLength` is that text’s length.
2. Write `snapshot.json` as today (`store-snapshot.mjs:18–40`).
3. Sync the folder, rotate, then prune the covered segments and every `held-*.json` other than `held-<S>.json`.

| Case | What happens | Test |
|---|---|---|
| Startup replay | `store-recover.mjs` loads `snapshot.json` into `state`, and `held-<seq>.json` into `held` if its `seq` and `snapshotLength` match the snapshot’s. Then the log replays: a `record` event applies to `held`, every other event to `state` | replay of a log with records yields the same `held` as the live store |
| A kill after step 1, before step 2 | the old snapshot (seq S0) and its `held-<S0>.json` are both still there, since pruning comes last; the log from S0 replays the rest. `held-<S>.json` doesn’t match the loaded snapshot, so it’s ignored, then removed once the next snapshot is committed | a kill between the two writes, in both orders — after the held file’s rename and before the snapshot’s, and after the snapshot’s rename and before the prune — and the loaded `state` and `held` match the live store’s at that seq |
| A kill after step 2, before step 3 | the new snapshot and its own `held-<S>.json` are both in place; the old pair’s files are left over and removed at the next prune | the second order of the test above |
| A kill between pieces of either file | the temporary file is never renamed: the old pair loads whole | as on `main`, per file |
| Retry’s reload (`store-retry.mjs`) | rebuilds `held` with `state`, from the same pair and log, before anything is writable | a Retry after an outage keeps every hold |
| An older build loading a newer folder | it reads `snapshot.json`, which is its own format, and never lists `held-*.json` (`store.mjs:150–152` keeps only `events-*`). The log’s `record` events throw “Unknown store event” in `apply` (`shared/state.mjs:171`) and replay as rejected, and it keeps loading (`store-replay.mjs:100–111`). The rejection names only the type. **Cost:** holds are dropped and held wakes behave as on `main` (D9) | an older loader on a newer folder: same conversations, no `held` key in its state, and no canary in its status text |
| Upgrading again | if the older build never snapshotted, `held-<S>.json` still matches and the log replays its records: no loss. If it did, its snapshot’s seq or size differs, so the newer build starts with `held` empty and deletes the stale file. **Cost:** holds made before the downgrade are lost; their cards still show, from the items | both, from a recorded folder |
| An older build run with `--fresh` | it deletes `snapshot.json` and the segments (`store-recover.mjs:126–127`), not `held-*.json`. A later snapshot could land on the same seq, so the size check is what rejects the orphan. The newer build’s `--fresh` pattern adds `held-\d+\.json` | an orphan with the same seq and a different size is dropped |
| A newer build loading an older snapshot | no `held-*.json`: `held` starts empty, and today’s `card.held` is converted once, by the conversion fixture’s rule | the conversion fixture |

## 6. Tests, failing first

- **The canary test** in §4.
- **#608’s findings (I6):** one spec each, failing on #608’s head `cdaa6237`, read only.
- **#366’s two cases and #594’s case,** failing on `main`.
- **The equivalence spec:** `asksOf(...)[0]` equals #633’s `nextNeed` on every fixture, except on ties, where code-unit order wins. `needsOrder` is held to the same order.
- **The conversion fixture** from `main`’s `se.needs` and `card.held`, synthetic and listed in `tests/fixtures/README.md`.
- **The §5b rows,** the older-build rows run with `main`’s `store-recover.mjs` and `store-replay.mjs` on a folder the newer build wrote.
- **One `asksOf` call,** timed on the 10× generated room.

## 7. UAT

None for this note: it’s docs only, and no run reaches it. The code PR runs `delivery.md` phase 1 (`held-behind-card`, `held-released`) and the needsnav triggers.

## 8. Pre-mortem

- **The derive is slower than a stored record on a long room.** Mitigation: the 10× timing, and the store’s item index if it misses.
- **A new module reads `store.held`.** The lint fails it unless it’s on the allowlist with a reason.
- **#633 changes again before A1b’s code starts.** The equivalence spec targets #633’s merged head.
- **Someone later wants holds offline.** That’s a separate design: a per-agent slice built before anything crosses to the host, with its own test (D12).
- **Someone puts `held` back into `snapshot.json` to save a rename.** The canary’s eighth check and I3 fail it.

## 9. Files

- **The code PR’s first commit, move-only:** `server/routes.mjs` (new) and `server/index.mjs`.
- **Then:** `shared/records.mjs` (new); `shared/state.mjs` and `server/live-streams.mjs`, both shared and mine this sprint (the stream is unchanged unless a frame needs it); `tests/store-held-guard.test.mjs`, also shared; `server/store.mjs`, `store-snapshot.mjs`, `store-recover.mjs`, `store-replay.mjs`, `store-retry.mjs`; `server/public-state.mjs`, `server/telemetry-report.mjs`, `server/card-needs.mjs` (from #633), `shared/needs.mjs`, the read tools’ module; and `tools/lint-security.mjs`.
- **This note:** `designs/508/a1b-asks.md`, a row in `designs/508/README.md`, and links from `design.md:133`, `:196`, `:562` and “Receipts”.
