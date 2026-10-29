# Design: delivery records and a windowed transcript

| | |
|---|---|
| **Status** | Approved, revision 11.2: revision 11, plus the person’s 28 October decisions on Redis’s build, license and platforms (“Storage”), plus “Store security” for requirements SR-1 to SR-8 (29 October). Wave 1 is built and in review; nothing has merged. |
| **Date** | 28 October 2026 |
| **Supersedes** | The design in #508’s description (“the approved design”), where this document differs. Its research and evidence still stand, and are cited by change number. |
| **Amends** | `designs/architecture.md`: “The store” (the store: persistence moves onto a bundled Redis 8 server, as its revisit line names Redis Streams), “The front end” (the front end) and “A conversation is shared memory” (shared memory); `designs/engineering-practices.md` (one managed native binary as the exception to zero runtime dependencies); `designs/intent.md` rows listed in “Rollout” |
| **Requirements** | The requirements comment on #508, revision 4.1 (comment 6482761957; ids DL, MD, AT, SW, PF, CX, MS). Its section “Acceptance, test first” names the test that decides each requirement. |
| **Acceptance scenarios** | Critic’s `testing-strategy.md` (approved in the room): `tests/uat/e2e/scenarios/delivery.md` and `bigroom.md`, with the triggers, checks, seed and launcher they need |
| **Reviews answered** | Integrator: comments 6481111995 and 6481619141. Critic: 6481670784, and critic’s seven findings on revision 3 in the room. Researcher’s findings on revision 3 in the room. Gemini’s nine implementation comments on revision 4 (threads gemini-1 to gemini-9). GPT’s principal-engineer review of revision 5 (threads gpt-10 to gpt-20). Critic’s request to make the UAT scenarios each step’s definition of done. Researcher’s backlog check: the prompt is saved before output on Codex and Antigravity. The room assets requirements (#516), reconciled in “Extension points for room assets” as extension points, not as scope. GPT’s storage review of revision 9 (threads gpt-21 to gpt-28). The person’s storage interview of 28 October, eight decisions, which chose a bundled Redis 8 over SQLite (“Storage”). |
| **Code baseline** | `main` at v0.42.3 (`9d049185`). Every file and line cited was read there. |

## 1. Summary

Postbox has two root problems:
- **Large rooms are slow in the browser.** The page holds and draws every item of every conversation.
- **Messages to agents are dropped, given twice or given out of order.** What was delivered, and what waits on the person, are found by scanning items and by a marker that moves before the turn has started.

This design makes four structural changes:
0. **Persistence moves onto a Redis 8 server that Postbox bundles and runs** (“Storage”): JSON documents are the truth, a stream carries the sequence, and both are written in one atomic transaction, so a turn’s records and marker commit together and nothing is published until they have. Values carry a version and are upcast on read, so no install ever runs a migration. The event log in JSON Lines could not give atomic writes without a transaction engine of our own, and a relational schema is ruled out by the person’s experience with SQLite migrations in an earlier Postbox.
1. **One record collection** replaces four partial mechanisms: `thread.queue`, `se.needs`, `schedules` and `se.context`. A record states what is addressed to whom, and where it is in its lifecycle.
2. **Delivery is decided by how a turn ends**, not by per-backend events. It is at least once, and every resend is labeled.
3. **The browser holds a window:** conversation headers and open records for every conversation, and a contiguous range of items for the conversations it shows. Items get server-assigned positions.

Everything else is either an existing mechanism kept as it is, or a separate feature with its own issue.

## 2. Context

### 2.1 How it works today

```mermaid
flowchart TD
  RT["Runtime: server/runtime.mjs"] -->|emit| LOG[("Event log and snapshot")]
  LOG --> ST[("store.state: everything")]
  ST -->|"/api/state: all items"| BR["Browser: same reducer, all items"]
  RT -->|"SSE: every event"| BR
  RT --> CU["catchUp: scans items after seenItem"]
  RT --> NQ["se.needs: one slot per session"]
  RT --> TQ["thread.queue: waiting messages"]
  RT --> SC["schedules: timed wakes"]
  RT --> CX["se.context: last 20 notices"]
```

- **Browser load:** `/api/state` sends all of `store.state` (`server/index.mjs:292`), and the transcript mounts every item it holds (`app/js/thread.mjs:109`). In this room that is 978 items and about 70,000 DOM nodes. In Safari, 48–87% of the tab’s main thread went to painting. In Chrome, a key press takes 63 ms, against 29 ms in a small room (approved design, “Why”).
- **Catch-up:** `catchUp` sets `seenItem` to the newest item while it builds the prompt, before the backend has accepted the turn (`server/catch-up.mjs:20`; `server/runtime.mjs:1582` delegates to it). Items its caps leave out are skipped for good (#484).
- **Waiting on the person:** `se.needs` holds one request per session (`shared/needs.mjs`). A second limited wake behind an open card is held on that card in `card.held` (`holdOnCard`, `server/wake-cards.mjs:74`), up to `HELD_WAKES` (20, `shared/limits.mjs:64`); past that its sender is told to send it again. The card, not a record, is the only link between the wake and the request holding it (#439). `openAsks` scans items (`app/js/open-asks.mjs`), so it undercounts once items aren’t loaded.
- **Notices to agents:** `tellAgent` appends to `se.context` and keeps the last 20 (`server/runtime.mjs:1374-1377`, 15 call sites in `server/`). A 21st notice silently drops the oldest. Urgent notes live in the same list.

### 2.2 What already exists and is kept

| Mechanism | Where | Kept because |
|---|---|---|
| Event log, snapshots, one reducer for server and browser | `server/store.mjs`, `shared/state.mjs` | Unchanged. This design adds event types. |
| Resuming the stream from `Last-Event-ID` against the global `seq` | `server/index.mjs:509-516` | It already gives “everything after N” with a resync fallback. |
| Activity steps sent as deltas | `activityStep`, `shared/state.mjs:144-148` (#452) | Already done. The approved design’s change 4 point about this is out of date. |
| Moving a revised block to the end with a stub | `bringForward`, `server/runtime.mjs:340-360` | It keeps the item’s id; only the stub’s id is new. |
| Urgent note on a Postbox tool result | `withUrgent`, `server/subagent-end.mjs:39` | It is the mid-turn delivery path on every backend. |
| Who hears a reaction | `reactionLines`, `server/thread-summary.mjs:207` | Decision 8.5 keeps this audience. |
| Addressed messages cut at 15,000, background at 2,000 | `READING.mention`, `READING.item` (`shared/limits.mjs:45-50`, #502); `tests/catch-up-whole-mentions.test.mjs` | The envelope keeps both bounds. |
| Rerender state kept outside the DOM across live updates | `app/js/rerender-state.mjs` (#494) | The window reuses it across unmounting (“Browser”). |

**Three facts about today’s store that drove the storage decision** (`server/store.mjs`): `emit` applies and broadcasts at once, then queues the append, and an append failure is only logged (`:98-126`); a snapshot writes the projection and deletes the log segments it covers (`:131-136`); and `load` truncates a torn last line and replays the valid prefix, so an append of several lines is not all-or-nothing (gpt reproduced this: one complete event and one truncated event loaded as `seq` 1). So nothing that leaves the projection survives the next snapshot, nothing emitted is durable until written, and a multi-event write can half-apply. “Storage” is the answer.

## 3. Goals and non-goals

**Goals**
- G1: A large room costs about as much to type in and paint as a small one (PF-1, PF-2).
- G2: Every message addressed to an agent reaches it, whole up to `READING.mention` (15,000 characters, #502) with the rest readable by `read_message`, and any repeat is labeled (DL-1 to DL-3, decision 8.2). The delivery metric counts records delivered, not characters.
- G3: “Needs you” is correct whatever part of a room is loaded, and several requests can wait at once (AT-1 to AT-4).
- G4: Fewer mechanisms than today: four partial ones become one.
- G5: Every step ships alone, keeps the full browser suite green, and is decided by specs written first that fail on `main` (MS-2), with a real-agent run that confirms (“Rollout”).

**Non-goals for this design.** Each has its own issue and keeps its decisions:
- Agent search (`search_conversation`). Decided on 28 October: its scope is the conversation and its side and topic threads, its index is in memory, and it joins `REPEATABLE` on hosts.
- Standing decisions (#14). Decided: Postbox proposes, and the person approves each one.
- Probe sets, hand-labeled judgments and replays (the approved design’s change 10, probe rows).
- Notify and wake as composer modes, and removing `wake_agent` (#472, #481). The records support them; they ship later.
- AT-5, the pair limit counting only loops (#492). The limit reads records after A1, which makes it possible; it is its own issue.
- Room assets (#516): files, notes and apps as one versioned store. Its design follows its two open decisions. “Extension points for room assets” says which parts of this design it builds on, so nothing here has to be undone for it.

## 4. Constraints

| Constraint | Source |
|---|---|
| No new runtime dependencies, with one explicit exception this design adds to `engineering-practices.md`: a managed native binary (Redis 8, built by Postbox’s CI) that Postbox downloads pinned, verifies and runs as a child process. No npm package is added. | `designs/engineering-practices.md`, “Keep runtime dependencies at zero” (PF-9); decision 1 of the storage interview |
| A key/value or document model, never a relational schema with migrations | The person, 28 October: an earlier Postbox on SQLite hit schema and migration problems between versions that stopped rapid change on existing installs |
| One process and one person today; more than one is likely within a year, so nothing may assume a single writer | `designs/architecture.md`, “The store” and “Remote hosts”; the person, 28 October |
| Same reducer on server and browser | `designs/architecture.md`, “The store” |
| Five backends, local and remote: Claude Code, Agent SDK, Kiro, Codex, Antigravity | DL-8 |
| Nothing enters an agent’s context unless it reads it or the person sends it | Intent principle 7 (CX-1) |
| Tuning values are measured, not picked | Person’s decision, 28 October (MS-3, proposed) |

## 5. Architecture

```mermaid
flowchart TD
  RT["Runtime"] -->|"emit, commit"| DB[("Redis 8, bundled: documents, stream, receipts")]
  DB --> ST[("Server state: all items, open records")]
  RT --> REC["Records: deliveries and asks"]
  REC --> ENV["Turn envelope"]
  ENV --> AD["Backend adapters"]
  AD -->|"turn outcome"| REC
  ST -->|"/api/state: headers, open records"| BR["Browser"]
  ST -->|"items API: one page"| BR
  ST -->|"SSE, filtered by open conversations"| BR
  DB --> MET["Metrics script"]
```

| Component | Responsibility | Owns |
|---|---|---|
| Store (changed, `server/store.mjs`) | The same interface; persistence is a Redis 8 child process Postbox manages (“Storage”). `emit` for optimistic events, `commit` for authoritative transitions, each a `MULTI` or Lua script; publish after the reply | The Redis process, its port and its data folder |
| Record store (new, in the reducer) | Holds open records; applies record events | `state.records` |
| Delivery rules (new, `shared/records.mjs`) | Pure functions: who a change reaches, de-duplication, every record transition (“Record lifecycles”), derived views (needs-you order, open asks, composer queue, scheduled wakes) | No state |
| Lifecycle owner (new, `server/records.mjs`) | The only code that emits `record` and `record.close`. Adapters report outcomes (“Delivering a turn”); they never patch a record. Asks and deliveries have separate validated shapes and transition tables. | — |
| Envelope builder (changed `catchUp`) | Builds a turn’s prompt from waiting deliveries and background; marks deliveries `sent` | The turn’s pending marker |
| Turn lifecycle (changed) | On first output, marks the turn’s deliveries `delivered` and writes the marker; on a failure with no output, returns them to `waiting` | — |
| Items API (new route) | Serves one page of a conversation’s items by position | — |
| Stream (changed) | Filters item and step events by the open-conversation list | — |
| Window (new, browser) | Holds a contiguous range per open conversation; the view state re-anchors on every DOM change | `client.windows` |
| Remote read contract (changed host tools) | Answers reads from the snapshot, else asks Postbox | — |
| Metrics script (new tool) | Computes MS-1 from the receipts (“Receipts”) of a room or a copy of its data folder | — |

## 6. Data model

**The data model is key/value and document, in memory and in the store.** The in-memory state is unchanged: collections that are maps keyed by id (`map()` in `shared/state.mjs`), kept current by the shared reducer on the server and in the browser. In Redis (“Storage”) each item, thread, session, record and app is a JSON document under its own key, and one stream carries every change in order. The server reads documents at startup; the browser still applies events from the stream. A `record` event writes one key, and `record.close` deletes it. This design adds one map and one in-memory index.

| Map | Key | Value | Readers | Bound |
|---|---|---|---|---|
| `state.threads` | thread id | thread header, now with `nextN` | Everything | Number of threads |
| `state.items` | thread id | that thread’s items, sorted by `n` | The window, the items API, catch-up | Grows with history; the browser holds only windows |
| `state.sessions` | session id | session, with `seenItem` | Everything | Number of sessions |
| `state.records` | record id | one open record (“Records”) | `shared/records.mjs` | Open records only: waiting and sent deliveries, open asks |
| Item index (in memory, never stored) | item id | its thread and position | The reducer, per streamed chunk | Same as `state.items`; replaces the linear `find` (#305 factor 4) |

In Redis the same lookups are served by plain structures beside the documents: a sorted set per thread scored by `n` for paging, a set per recipient for open records, and the document key for an id (“Storage”).

**Lookups**

| Lookup | How | Why that’s enough |
|---|---|---|
| A record by id | `state.records[id]` | — |
| A recipient’s open records | A scan of `state.records` filtered by `to` | Open records are few (INV-7), so a scan costs less than keeping an index current |
| The open record for `(to, sourceId)` | The same scan | As above; it enforces INV-3 |
| An item by id | The item index | Called for every streamed chunk |
| A page of items | Binary search on `n`, then a slice | The list stays sorted by `n` (“Items: position and revision”) |

- **No read needs a join or a query across history.**
- **The item index is derived.** The server and the browser rebuild it when state loads, and the reducer keeps it current. It is never migrated.
- **References are ids** inside values, such as a record’s `sourceId`, `to` and `heldBy`. Nothing enforces them as foreign keys. A record whose source item is gone stays readable, and its envelope line says the item was deleted.

### 6.1 Items: position and revision

| Field | Meaning | Set by |
|---|---|---|
| `n` | The item’s position in its conversation. Only grows. | The server, when it writes `item.add` or `item.move` |
| `rev` | Which version of the item this is | The server, on any change an agent could be told about (“What reaches agents”) |

- **A move keeps ids.** `item.move` gives the moved item the thread’s next `n`. Its stub, which has a new id, takes the item’s old `n`. Reactions, `read_message`, topic threads and Work rows keep pointing at the same id.
- **`thread.nextN`** is the counter. It lives in the thread header.
- **Old data:** when a snapshot loads, items without `n` are numbered in list order, and `nextN` is set past the last. Log events from before the upgrade are replayed by the same rule: an `item.add` without `n` takes `nextN`, and an `item.move` without `n` gives the moved item `nextN` and its stub the item’s old `n`. A replay test covers both. No versioned migration is needed.

### 6.2 Records

```
{
  id:        string,                       // rec_…
  kind:      'delivery' | 'ask',
  threadId:  string,                       // where it was addressed
  to:        sessionId | 'person',
  from:      sessionId | 'person' | 'postbox',   // 'postbox' for notices that tellAgent sends today
  sourceId:  string,                       // the item it’s about. Before the item exists it is the record’s own id;
                                           // posting the item overwrites it with the item’s id, so one key serves every lookup
  rev:       number,                       // the newest revision of the source still owed to the recipient
  sentRev?:  number,                       // the revision whose content went out in turnId; set when sent, cleared when settled
  attempt?:  number,                       // how many times this record has been sent; the label counts from 2
  mode:      'wake' | 'notify' | 'interrupt',
  state:     see “Record lifecycles”,
  reason?:   'held' | 'busy' | 'scheduled' | 'resend',
  heldBy?:   string,                       // the ask that holds it, when reason is 'held'
  urgent?:   boolean,                      // a notice for the agent mid-turn (“Delivering during a turn”)
  parts?:    [{ text, at }],               // a waiting message’s text, until its item is posted; a superseding wake keeps every part
  turnId?:   string,                       // set when sent
  notBefore?: number,                      // a scheduled wake’s time
  askKind?:  'block' | 'permission' | 'toolask' | 'hop' | 'appsend' | 'note' | 'blocked',   // 'note': a room-note proposal (#516 NT-2)
  folded?:   { count, before },            // notifications folded into this one, and the oldest one’s n, for read_conversation
  at:        number
}
```

- **Key:** at most one open record per `(to, sourceId)` (INV-3). When a waiting message’s item is posted, `sourceId` becomes the item’s id, so an edit that looks the record up by item id finds it.
- **Pending work and the attempt in flight are two fields.** `rev` is the newest revision owed; `sentRev` is what turn `turnId` was given. An edit while the record is `waiting` raises `rev`, and the agent gets the newest text once. An edit while it is `sent` raises `rev` and leaves `sentRev`: when the turn settles, the attempt acknowledges `sentRev` only, and because `rev > sentRev` the record doesn’t close but goes back to `waiting` as an amendment, with `parts` holding the diff from `sentRev` to `rev`. The diff is computed when the edit happens, from the item’s text before and after, and kept on the record, since the item alone can’t recover the version the recipient saw. A settle for a `turnId` that isn’t the record’s current attempt is ignored. **Cases in the tests:** an edit before the turn’s first output, an edit after it, and a late settle from an old attempt.
- **Open notifications are bounded.** At most `openNotifies` open `notify` records per recipient (a setting in “Observability and calibration”). Past it, the oldest close as `folded` into one record that carries a count and the oldest folded item’s `n` (`folded`), so an idle agent in a busy room doesn’t grow `/api/state` (INV-7). Every folded source is an item (“Postbox notices as items”), so nothing becomes unreadable; the envelope says how many were folded and gives the cursor. A2’s done-when distinguishes what the envelope included from what it left behind a pointer.
- **Size:** each part’s `text` is bounded by the composer’s and the tools’ existing limits, and MD-3’s cap folds a sender’s parts beyond it.
- **Notices from Postbox** (`tellAgent` today) are `notify` deliveries with `from: 'postbox'` whose source is a notice item (“Postbox notices as items”). Nothing drops the oldest; MD-3’s fold applies instead. Urgent notes are the same deliveries with `urgent: true`.
- **`se.needs` mapping:** `block`, `permission`, `toolask`, `hop` and `appsend` become `ask` records. `failed` and `denial` describe a session, not a request, so they stay as session status. `needsOrder` in `shared/records.mjs` takes the union: an open ask sorts by its `at`, and a failed or denied session by `se.updatedAt`, which is what `waitedSince` (`shared/needs.mjs:26`) falls back to today. Neither reads items.

### 6.3 What is state, what is in the store, and what reaches the browser

| Data | In `store.state` | In `/api/state` | In Redis |
|---|---|---|---|
| Open records (`waiting`, `sent`, `open`) | Yes | Yes | A document each, plus the recipient set |
| Closed records | No | No | Deleted; the closing stream entry stays until the stream is trimmed |
| Receipts (“Receipts”) | No | No | A document per record, written in the same transaction as its events; server-only, bounded |
| Items | Yes | No: the items API serves pages | A document each, plus the thread’s sorted set |
| Thread headers, with `nextN` and stats | Yes | Yes | A document each |
| App headers | Yes | Yes (PF-7) | A document each |
| The event sequence | — | Resumed from `Last-Event-ID` | The `events` stream, trimmed by retention |

Closed records leave state, so `/api/state` stays bounded by what is open, not by a room’s age. The history that explains a delivery lives in the receipts (“Receipts”), written in the same transaction as the event that closes the record.

### 6.4 Receipts

A server-only document per delivery record, `receipt:<id>`, written by the lifecycle owner in the same transaction as the record events it describes. It is not state, not in `/api/state`, and not applied by the reducer.
- **One entry when a delivery record opens** and one when it closes or is resent, appended to the document’s `rows`: `{ event: opened | delivered | superseded | expired | withdrawn | answered | resent, at, rev, sentRev?, turnId?, attempt?, reason? }`, beside the record’s `kind`, `to`, `from`, `threadId`, `sourceId` and `openedAt`.
- **No dual write.** The record event and its receipt commit together or not at all, so a crash can neither close a record without its receipt nor record a receipt for a close that never committed. A repeated operation, found by its id in `ops`, writes nothing twice.
- **Why both entries:** MS-1’s completeness divides by addressed work, so a record that opened and never closed still counts. A metric built only from closes would hide a dropped record.
- **Retention is bounded:** a sorted set `receipts:closed`, scored by the closing time, holds every closed record’s id; past `receiptsKeep` entries the oldest closed receipts are deleted whole. An open record’s receipt is never in that set, so it is never pruned, and completeness and lag stay honest.
- **Reading it:** the metrics script only. No HTTP route.
- **Test:** open and close records, restart, and the script’s counts are unchanged; a transaction that fails between the event and the receipt leaves neither.

### 6.5 Postbox notices as items

`tellAgent`’s strings live only in `se.context` today (`server/runtime.mjs:1374-1377`): they aren’t items, so nothing can read one back once it has been folded. Under this design a notice from Postbox is written as a `system` item with `variant: 'notice'` and the recipient’s `sessionId`, in the recipient’s thread. Like today’s hidden system items it draws nothing in the transcript, but it has an id and an `n`, so `read_message` and `read_conversation` reach it. The delivery record’s `sourceId` is that item. Folding (“Records”) therefore loses nothing: the fold record’s `folded.before` is the oldest folded item’s `n`, and `read_conversation { before }` recovers every one.

### 6.6 Storage: a Redis 8 server that Postbox bundles and runs

**Decision (the person, 28 October 2026, after a structured interview; eight parts below).** Persistence moves from the JSON Lines log plus `snapshot.json` onto a Redis 8 process that Postbox downloads, verifies, starts and upgrades itself. Everything above the store is unchanged: the event types, the shared reducer, the in-memory projection, the stream to the browser and `/api/state`. Large files stay in the content-addressed blob folder.

**Why.** `architecture.md`, “The store” chose JSONL for one person, one process and reads of “all of it”, and said to revisit when Postbox needs transactions across files or queries across history, naming Redis Streams as a candidate. Revisions 6 to 9 of this design asked the store for exactly that: a turn’s `sent` records and marker written together before an adapter starts; receipts that survive compaction; an all-or-nothing settle; and, for #516, an atomic base-version check. JSONL gives none of these without a transaction engine of our own, and its multi-line append is not even atomic today (“What already exists and is kept”). Two of the person’s constraints decide between the remaining options: the data model must be key/value or document, never a relational schema, because an earlier Postbox on SQLite was stopped by schema and migration problems between versions; and more than one Postbox process or person is likely within a year, so nothing may assume a single writer. Redis fits both; SQLite fits neither well.

| Option | What it gives | What it costs | Outcome |
|---|---|---|---|
| JSON Lines plus transaction framing, commit markers, torn-batch recovery, a receipts file with its own rotation, and a serial writer | No new component | A transaction engine written and tested only by Postbox; two files that must agree | Rejected |
| SQLite through `node:sqlite` (revision 10’s choice) | Atomic transactions in one file, no server | A relational schema is the natural shape and the one that caused the earlier migration pain; synchronous writes block the event loop; a single-process design by nature; Node 24 minimum | Rejected on the person’s constraints |
| **Redis 8, bundled and managed by Postbox** | Atomic multi-key writes (`MULTI`, `WATCH`, Lua), a sequenced stream, JSON documents with path updates, search in the store, a path to several processes | A native binary to download, verify, supervise and upgrade; an exception to zero runtime dependencies; durability that is a configuration choice | **Chosen** |

**The eight decisions.**
1. **Postbox bundles and manages Redis.** It runs as a managed child process. The proposed “Store security” amendment selects an authenticated private Unix socket; credentials, persistence files and logs remain private to the application, with their lifecycle chosen there. Postbox starts it before it listens, stops it on exit, restarts it if it dies, and upgrades it with Postbox releases. The person installs nothing and is told when it isn’t running (decision 7).
2. **The binary is Postbox’s own pinned build, downloaded at first start.** Redis publishes no per-platform binaries, only a source tarball with its SHA-256 on `download.redis.io` ([redis.io/downloads](https://redis.io/downloads/)). So Postbox’s CI builds Redis **8.10.3** from that tarball for three targets, macOS arm64, Linux arm64 and Linux x64, and hosts each build as a release asset beside the matching source. First start downloads the build for its platform, verifies its checksum against a value in Postbox’s release, and keeps it under the data folder. First start needs the network. (Revised 28 October: this replaces “a pinned release per platform”, which assumed vendor builds.)
3. **Durability is `appendfsync everysec`.** A committed write survives a Postbox or Redis process crash. After a power cut, up to a second of writes can be lost, so a resend in that one case may arrive without its label. This is a stated limit of INV-12, chosen over `appendfsync always` (an fsync per streamed chunk) and over a `WAITAOF` barrier at dispatch.
4. **Documents are the truth, and the stream is the sequence, written together.** Every write is one `MULTI` or Lua script that updates the JSON documents it touches and appends one entry to the `events` stream, whose entry id is the event’s `seq`. Startup reads documents: no replay, no snapshot. The browser and the receipts read the stream; it is trimmed by a retention rule (“Observability and calibration”), never by a snapshot.
5. **Values are upcast on read and never rewritten.** Every document carries a small `v`. The reader lifts an older shape to the current one through pure functions, and writes the current shape only when it next changes that document. No install runs a migration at startup. Downgrading Postbox is unsupported once a newer shape has been written, and the release notes say so. This applies the rule for events in `architecture.md`, “The store”, to documents.
6. **Redis 8’s built-in JSON and search from the start:** `JSON.GET` and `JSON.SET` with paths for documents and partial updates, and `FT.SEARCH` for search when the agent search issue ships, in place of BM25 inside Postbox. Plain structures serve the design’s own lookups: a sorted set per thread scored by `n`, a set per recipient for open records, `ops` for idempotency.
7. **When Redis is unreachable, Postbox fails closed for writes and keeps the page readable.** No turn starts and no write is accepted while the child isn’t answering; in-flight turns are stopped and their records go back to `waiting`, labeled; the browser keeps showing the in-memory state read-only; one status line names the cause (port taken, binary missing, corrupt AOF, process died) with a Retry. Postbox never writes anywhere else meanwhile, so there is no reconciliation path.
8. **One writer now, and every transition atomic in Redis.** Each record transition, settle and conversion is a Lua script or a `MULTI` under `WATCH` on the keys it changes, so correctness never depends on being the only process. A second Postbox process isn’t built or tested yet; when it comes it connects to the Redis the first process owns, and the transitions already hold.

**License and platforms** (the person, 28 October).
- **License:** Postbox takes Redis 8 under **AGPLv3**, one of the three licenses Redis 8 offers (RSALv2, SSPLv1, AGPLv3; [`LICENSE.txt`](https://raw.githubusercontent.com/redis/redis/unstable/LICENSE.txt)), and offers the matching source with every release that carries a build. Postbox talks to Redis as a separate process over its protocol, so Postbox’s own license is unaffected. The exception in `engineering-practices.md` and the release notes both say so.
- **Supported:** macOS arm64, Linux arm64 and Linux x64.
- **Unsupported:** macOS on Intel (Homebrew has no Redis build for it either) and Windows (Redis doesn’t support it). Postbox checks the platform before it downloads anything and refuses to start on either, with a message that names the platform and the supported ones, rather than failing a download.

**How it works.**
- **Keys:** `item:<id>`, `thread:<id>`, `session:<id>`, `record:<id>`, `app:<id>`, `receipt:<id>` as JSON documents; `thread:<id>:items` a sorted set of item ids by `n`; `recipient:<id>:open` a set of record ids; `receipts:closed` a sorted set by closing time; `ops` a hash from operation id to `seq`; `events` the stream. Reserved for #516: `asset:<id>` and `room:<id>:assets`.
- **`emit(type, data)`** keeps its optimistic order for high-rate, non-authoritative events, which today are streamed text and activity steps: apply and broadcast at once, then write pipelined, one `MULTI` per tick. A failed write here is logged and surfaced once per session, as today; nothing a lifecycle depends on travels this way.
- **`commit(events, opId)` publishes after the reply.** It stages the events, runs one script that checks `ops`, updates the documents, writes the receipts and appends to the stream, and only after Redis replies does it apply the events to the state and broadcast them. If the write fails, nothing was applied or seen; the records are still `waiting`. A repeated `commit` finds its `opId` and returns the earlier `seq`.
- **Startup:** read the documents, rebuild the item index, and resume the browser stream from the client’s `Last-Event-ID` with `XRANGE`; a client behind the trimmed window gets `resync`, as today.
- **Backups** are a copy of the data folder, which holds the AOF; Postbox makes the dated one at the Store step’s first start (“Migration, compatibility and rollback”).
- **Tests:** a kill during a `commit` leaves documents and stream consistent; a failed `commit` leaves state and clients unchanged; a repeated `opId` writes once; the child failing to start shows the status and holds writes; the child dying mid-turn returns the turn’s records to `waiting`, labeled; two Postbox processes against one Redis keep every transition consistent (a test only, not a supported mode yet); write round-trip latency on a copy of this room against today’s store, with a budget in “Observability and calibration”.

#### Store security

**Status:** design for requirements revision 4.3 (“Store security”, SR-1 to SR-8), approved 29 October 2026. Store (#525) builds it; SR-1 to SR-7 are in review on `feat/508-store` at `5b2e6392`, and SR-8 was already met. The command list below was taken from Store at `4e9dde59`.

**Boundary.** One person directs agents on one computer. Browser-origin attacks, accidental direct agent access and new paths from remote hosts remain in scope. A determined process running as the person is outside it, including an agent told exactly how to read the data folder or obtain credentials. That is the explicit boundary in `architecture.md`, “Writes need the page’s token”, and `SECURITY.md`. Private file modes and Redis authentication do not isolate agents running as the same OS user. The goals serve `intent.md`, “Who it’s for”, “Get the loop right before the looks” and “You stay in charge of your agents”; they do not add a multiuser isolation system.

```mermaid
flowchart TD
  B["Browser: page token"] --> H["Postbox HTTP and MCP"]
  A["Agents: turn token"] --> H
  R["Remote hosts: existing broker"] --> H
  H --> S["Store: authenticated private connection"]
  S --> D["Redis: documents and stream"]
```

**Transport and files (SR-1, SR-4, SR-5).** A private Unix socket is a simple choice on the three supported Unix platforms: `port 0`, no TCP/TLS listener, a 0700 directory and an owner-only socket. Refuse an invalid or overlong socket path rather than silently opening TCP. Unix-only is a transport choice, not proof that authenticated loopback is inherently insecure. Another-user connection tests are optional evidence, since another OS user is outside this product’s threat model. The socket is never forwarded to a remote host.

Create private store directories as 0700, data/configuration/log files as 0600 and actual executable files as 0700. Modules and libraries need owner read permission, not blanket execute permission. Apply private defaults to AOF rewrites and handle existing installations explicitly. Refuse substituted links where the owner creates, loads or cleans up private resources. State `protected-mode yes`, `enable-protected-configs no`, `enable-debug-command no` and `enable-module-command no` explicitly; load only the selected verified modules at startup. These are inexpensive defaults, not an OS-user isolation guarantee.

**Credential (SR-2).** Only Store receives the Redis credential. Do not put it in an agent’s prompt, tool result, environment, process arguments, logs, telemetry, room assets or host payloads. Do not expose a route that retrieves it. A random credential may remain in a validated 0600 private file, as the remote daemon’s token already does, or be passed through stdin and retained in memory. The design chooses the simpler lifecycle that supports authenticated reconnect and safe cleanup. Memory-only storage and rotation on every child restart are optional hardening, not requirements imposed by the bounded threat model. Store credentials are application tokens, not backend API keys.

**Commands (SR-3).** Start a named user from `-@all` and add explicit commands, with the default user disabled. Keep replication, migration, runtime configuration, module loading and ACL administration unavailable: they can turn database access into outbound connections or configuration changes. Test direct calls and Lua calls. This follows [Redis’s trusted-client security model](https://redis.io/docs/latest/operate/oss_and_stack/management/security/), [ACL rules](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/) and [Lua ACL checks](https://redis.io/docs/latest/develop/programmability/lua-api/).

At `4e9dde59`, the normal reader and writer need `AUTH`, `PING`, `EVAL`, `GET`, `SET`, `HGET`, `HSET`, `DEL`, `RENAME`, `ZADD`, `ZREM`, `ZRANGE`, `XADD`, `XRANGE`, `JSON.SET`, `JSON.GET` and `JSON.MGET`, including the writer’s `stage:*` keys and its inner Lua calls. Do not grant module-wide or category-wide permissions merely because a module is loaded. Search and durability commands are added when their callers ship. Current scripts use dynamically named keys with `EVAL ... 0`; no Redis Cluster compatibility is claimed.

The existing owner cleanup additionally uses `SHUTDOWN`. If that authenticated cleanup is retained, its explicit lifecycle permission must be accounted for; the normal writer’s list above is not the whole supervisor/import allowlist. The importer also uses `FLUSHDB` to resume an interrupted import. Reset/import stays private to startup, with no agent, browser or host entry point. A scoped import account is an option, not a mandatory Redis restart and second credential lifecycle. Allowing this command only because the importer actually needs it is consistent with an explicit command allowlist: the writer already has whole-store `DEL` and `EVAL`, so prohibiting `FLUSHDB` alone does not create data isolation. Administrative fixture commands must not broaden the production account without a real production caller.

**Ownership and leftovers (SR-6).** Stop the managed Redis child on normal shutdown and identify an earlier instance safely at startup. Do not stop another live owner, signal a reused PID or follow a substituted endpoint. Ambiguous ownership fails closed with a useful recovery message. Keep bounded startup/shutdown waits and avoid leaking a new child on failed startup. Immediate orphan termination after SIGKILL, a separate owner helper and a stop-only control endpoint are optional designs requiring separate justification; a private authenticated orphan until safe cleanup is not by itself an in-scope access breach. Future multi-process ownership remains separate from Redis-side transition atomicity.

**Agents and hosts (SR-7).** Ordinary agent actions use the validated HTTP/MCP path. Never distribute the socket path or Redis credential in guides, environments, MCP results or other ordinary agent inputs, and never automatically add store directories to agents’ workspaces. Remote hosts receive neither the socket path, a Redis connection nor its credential. Direct access attempts must obey each backend’s existing selected permission policy. Add focused tests for new permission integrations and document their actual limits. Do not change Auto into Ask or mark an otherwise supported backend unusable because it lacks isolation from processes running as the same user. Raw AOF reads have the same scope limit as today’s data-folder reads; changing that boundary would require a separate product decision.

A scratch probe returned `EPERM` for a Unix-socket connection in this macOS Codex workspace sandbox, while an unsandboxed control reached the same listener. This proves that configuration only, not Linux or every Codex mode. [Official OpenAI documentation](https://learn.chatgpt.com/docs/agent-approvals-security) describes separate Unix-socket policy controls, so network-off must not be advertised as a universal Unix-socket guarantee. Codex Auto uses its own approval reviewer; not every escalation is a person-facing card.

**Build integrity (SR-8).** Keep the platform pin, authenticated download, checksum verification, safe extraction and atomic installation. Do not treat an editable `.sha256` marker as proof that installed files are unchanged. Verifying every executable, module and library against a pinned manifest on every automatic restart is optional integrity hardening; it is not a Store gate without an in-scope substitution case or measured corruption problem. If installed-file verification is chosen, derive expected file hashes from the pinned verified archive or an independently pinned manifest, never from an untrusted sidecar.

**Acceptance.** Test private transport/configuration, authenticated access, the real writer under its command allowlist, refusal of dangerous direct/Lua calls, no credentials in agent/browser/host payloads, private file creation, safe normal shutdown and leftover recovery, and verified installation. Test backend permissions where this change integrates them; document unsupported guarantees without inventing a stronger boundary. Update `architecture.md`, `SECURITY.md` and applicable `AGENTS.md` instructions with the approved implementation. Durability and delivery acceptance remain separate. Credential-only-in-memory, a helper process with a lifeline, a bootstrap account and restart, and per-start installed-file hashing are options, not requirements of SR-1 to SR-8.

**Not changed by this decision.** The agent-delivery rules: who a change reaches, held asks, `sentRev` and attempt fencing, the envelope, and the uncertainty of a backend’s receipt. Redis gives the write a boundary; it doesn’t know whether a model read a prompt.

## 7. Behavior

### 7.1 Record lifecycles

```mermaid
stateDiagram-v2
  state "Delivery" as D {
    [*] --> waiting
    waiting --> sent: envelope built
    sent --> delivered: turn produced output
    sent --> waiting: turn failed, no output
    sent --> waiting: settled, but rev is newer than sentRev
    waiting --> superseded: same sender posted again
    waiting --> folded: past openNotifies
    waiting --> expired: removed, canceled or not allowed
    waiting --> blocked: maxResends reached
    delivered --> [*]
    superseded --> [*]
    folded --> [*]
    expired --> [*]
    blocked --> [*]
  }
```

```mermaid
stateDiagram-v2
  state "Ask" as A {
    [*] --> open
    open --> answered: person answered
    open --> withdrawn: agent withdrew, or settled another way
    open --> expired: session archived or thread deleted
    answered --> [*]
    withdrawn --> [*]
    expired --> [*]
  }
```

| Transition | Trigger | Code path |
|---|---|---|
| → waiting | A message addresses an agent; a change concerns one (“What reaches agents”); a scheduled wake is set | `sendMessage`, `postAndDeliver`, `deliverWake`, the schedule tool |
| waiting, `reason: held`, `heldBy` | The pair or hop limit holds it behind an ask | The limit check; replaces `card.held` (`holdOnCard`), keeping its cap of `HELD_WAKES` and its message to the sender past it |
| held → waiting | The person allows the ask: every delivery with that `heldBy` is released (AT-1) | The ask’s answer route |
| held → expired | The person doesn’t allow it: each held delivery expires, and its sender gets a `notify` saying so | The ask’s answer route |
| waiting, `reason: held`, behind an Add card | A wake or notification for a persona not in the conversation raises the Add card as an `ask` and is held on it, like a limited wake (AT-7). Allow adds the persona and releases it; otherwise it expires and the sender is told. | The Add card route |
| waiting → sent | The envelope builder includes it; `sentRev = rev`, `attempt += 1`; the `record` event is committed (“Delivering a turn”) before the adapter starts | `catchUp`’s replacement |
| sent → delivered | The turn’s first qualifying output (“Delivering a turn”), with `rev == sentRev` | Turn lifecycle |
| sent → waiting, amendment | The turn’s first qualifying output, with `rev > sentRev`: the attempt is acknowledged and the newer revision stays owed, as a notify carrying the diff | Turn lifecycle |
| waiting → blocked | `attempt` reaches `maxResends`: the record stops being resent, and an `ask` of kind `blocked` tells the person which message couldn’t be delivered and to whom. The ask stays open until the person answers it (resend once more, or drop it), so the message is never silently expired: DL-1 holds because it still waits on the person, and AT-1 and AT-2 make that visible. | Turn lifecycle |
| waiting → folded | The recipient has more than `openNotifies` open notifications; the oldest close as folded, counted on the fold record | Lifecycle owner |
| sent → waiting, `reason: resend` | The turn ends failed with no output; or Postbox restarts with a local turn’s record still `sent` | Turn lifecycle; startup |
| delivered, then a transient failure | The turn failed after output with a transient error, such as a network drop (#466, #467), as judged by one predicate for every backend: `isNetworkFailure(error)`, which walks `error.cause` for `kind: 'unreachable'` or a code in `NETWORK_CODES`. It lives on the `fix/466-wake-retry` branch (`server/scheduled-wakes.mjs:51`), not yet on `main`; A2 takes it from there. A new labeled delivery from `postbox` says “your last turn stopped after starting work; check what ran”, and carries the original parts. Scheduled wakes lost this way are retried by it (SW-2). | Turn lifecycle |
| sent, on a host, across a restart | A host turn keeps running while Postbox is down. Its `sent` records stay until the replayed stream shows how the turn ended, then follow the rules above. If nothing is heard within the host timeout, they go back to `waiting` as resends. | Remote turns on reconnect |
| waiting → superseded | **Agent wakes only:** the waker posts again in the thread before its wake is delivered, with or without a new mention (`intent.md`, “Messages sent mid-reply”). The new post’s record takes the old one’s `parts`, each with its own time, and the old one closes as superseded (DL-6). The person’s queued messages are never superseded, so each keeps Edit and Remove (AT-6). | `deliverWake`, the agent’s post path |
| waiting → expired | The recipient is archived or removed, the conversation is deleted, or the wake is canceled (SW-1, SW-3). Archiving puts a line in the conversation for each canceled scheduled wake. Deleting removes the conversation and its sessions, so there is no one to tell: the delete confirmation lists the scheduled wakes it cancels instead. | Archive, delete and cancel paths |
| ask: open → answered or withdrawn | An answer; `update_block` withdraw; the request is settled another way (AT-3) | Answer routes; `retireStale` (`server/wake-cards.mjs:174`) |

“Seen” is not a state (decision 8.6): Postbox can’t observe it.

### 7.2 Invariants

| Id | Invariant | Checked by |
|---|---|---|
| INV-1 | A record is never deleted while open. It leaves state only by a closing transition. | Reducer test |
| INV-2 | A delivery becomes `delivered` only after its turn produced output, or after Postbox returned the tool result carrying it. | Turn lifecycle tests, one per backend |
| INV-3 | At most one open record per `(to, sourceId)`. A newer revision updates it. | `shared/records.mjs` unit test; an edit while a mention waits |
| INV-4 | Every resend carries its label. The count of unlabeled repeats is 0. | Metrics script on a copied room |
| INV-5 | An item’s `n` never changes, except that a move gives it a new, larger `n`. No id changes. | Reducer test |
| INV-6 | The session marker moves only when the turn produced output, and in the same settle as its deliveries. | Turn lifecycle test |
| INV-12 | No adapter is started before Redis has acknowledged the transaction marking its deliveries `sent`, and nothing is applied or broadcast before that reply. Holds against process crashes; a power cut within one second is the stated exception (“Storage”, decision 3). | Crash tests at the dispatch boundary: Redis killed during the write, write refused, disk full |
| INV-13 | A settle acknowledges only the attempt and `sentRev` it names; a newer `rev` stays owed. | Edit-in-flight tests |
| INV-7 | `/api/state`’s size doesn’t depend on the number of closed records or items, and open `notify` records per recipient never exceed `openNotifies`. | Size check on a copied room with an idle agent |
| INV-8 | Outside the window module, no browser module reads `state.items`. | Lint check over `app/js` |
| INV-9 | A turn’s background never repeats an item that this recipient has a delivery for: one in the same envelope, or one delivered mid-turn since the marker. | Envelope unit test; #484’s case |
| INV-10 | Every held delivery names an open ask in `heldBy`; closing that ask releases or expires it. | `shared/records.mjs` unit test; #439’s case |
| INV-11 | Deliveries are never dropped by the catch-up’s aggregate caps, and each is cut at `READING.mention` (15,000), not `READING.item` (2,000), with a `read_message` pointer for the rest (#502). | `tests/catch-up-whole-mentions.test.mjs`, extended to records; #484’s oversized oldest mention |

### 7.3 Delivering a turn

**Durability at the dispatch boundary.** Today’s `emit` applies and broadcasts first and appends later, and an append failure is only logged (`server/store.mjs:98-126`). That isn’t enough where an external turn starts: a crash after `emit` and before the append would restart with no record that the attempt was made, and the resend would carry no label; and once clients have seen `sent`, there is nothing to roll back. So the lifecycle owner uses `commit` (“Storage”): the `sent` transitions and the turn’s pending marker are written in one atomic script, and applied and broadcast only after Redis has replied. Then the adapter starts. With `appendfsync everysec` that write survives a process crash; a power cut within the same second can lose it, which is the one stated limit of this rule (decision 3). If the write fails, nothing was applied or seen; the records are still `waiting`, the turn doesn’t start, and the session shows the error. Settlement is one idempotent `commit`, `settle(turnId, outcome)`: it closes exactly the `sent` records with that `turnId`, writes their receipts and the marker in the same transaction, and a repeat with the same `opId` writes nothing. Startup conversions (“Migration, compatibility and rollback”) are one `commit` each: the new records and the cleared source commit together, and a repeat finds its `opId` and does nothing, so a crash between them can’t make a second delivery.

```mermaid
sequenceDiagram
  participant P as Person or agent
  participant R as Runtime
  participant S as Records
  participant A as Adapter
  P->>R: message mentioning the agent
  R->>S: delivery, waiting
  R->>S: build envelope, mark sent with turnId
  R->>A: start turn
  alt first text or tool step
    A-->>R: output
    R->>S: delivered
    R->>R: write the pending marker
  else failed with no output
    A-->>R: turn failed
    R->>S: back to waiting, reason resend
  end
```

**The envelope**, in order:
1. The request being answered, where it was asked, and where the reply goes (DL-4, #504).
2. In a topic thread, the message it started from.
3. What changes during a room: the room list, the brief, the room’s approved notes (reserved for #516 NT-3; empty until then), session facts and tools turned off (CX-3, #515).
4. Waiting deliveries, wakes and notifications together, in the order they were posted, each line marked as a wake or a notification and carrying its `sourceId` and `rev`. Resends say “sent again after a failed turn”. Notifications are capped per sender and folded into one line (MD-3). The catch-up’s aggregate caps never drop a delivery, and a delivery is cut at `READING.mention`, the background at `READING.item` (INV-11, #502).
5. Background since the marker, labeled as background, with a count and a `read_conversation` cursor for what was left out (DL-5). It leaves out every item that a delivery in this envelope comes from (INV-9), so a mention isn’t given twice (#484). The session keeps the ids of items delivered mid-turn until the marker passes them.

The system prompt holds only what is fixed for a persona version (#515).

**Why “first output”.** Once the model has produced a step, it has read the prompt. Before that, Postbox can’t tell. A backend can save the prompt into the session before failing: gpt found a Codex 0.163.0 turn whose prompt was written and then aborted with no output, and gemini found an Antigravity session with a saved prompt and no response. Whether the agent then sees that prompt twice on its next turn is still unconfirmed, since neither found a later turn after such a failure. That is why a resend is labeled rather than assumed safe. One recorded failing turn per backend, with the turn after it, settles the rest before step A2 ships.

**What counts as output.** The rule is adapter-neutral: an adapter reports events, and `shared/records.mjs` decides. Qualifying: an assistant text delta or a tool call that belongs to the current attempt’s turn id. Not qualifying: initialization and session events, permission prompts, replayed history on resume, a compaction summary or the string-form continuation that follows one (#513), and a subagent’s own events until the parent turn produces its own step. Each adapter’s recorded events become fixtures for a shared conformance matrix, one row per outcome, so the policy is tested once and lives outside the adapters.

| Outcome | Deliveries | Marker |
|---|---|---|
| Qualifying output, then success | delivered (or amendment, INV-13) | moves |
| Success with no output (an empty turn) | delivered: the backend finished reading the prompt | moves |
| Failure with no output, including refusal and auth failure | waiting, `reason: resend` | stays |
| Qualifying output, then transient failure | delivered, plus the check-what-ran delivery (“Record lifecycles”) | moves |
| The person’s Stop | delivered if output had started; otherwise waiting, labeled “stopped before it was read” | as the row above |
| Host timeout, then the host reconnects with a later attempt running | the settle names the old attempt and is ignored (INV-13); the running attempt settles on its own evidence | — |

**Resends don’t loop.** The runtime owns retries: a `waiting` record is sent again only when its recipient’s next turn is built, never on a timer. After `maxResends` attempts (3, decided 28 October) the record goes `blocked` and the person gets an open ask naming the message and its recipient, with “Send once more” and “Drop it”. The message stays waiting on the person until they answer, so it becomes visible instead of being tried forever, and nothing is dropped without them (DL-1, AT-1, AT-2).

### 7.4 Delivering during a turn

- **Local:** the urgent note goes ahead of a Postbox tool result. Its deliveries become `delivered` when Postbox returns that result.
- **On a host:** `withUrgent` takes the note when the reply is built (`server/remote/turns-tools.mjs:45`). If the link drops, the daemon’s repeat is answered from a kept copy cut to `KEPT_REPLY_CHARS`. So:

```mermaid
sequenceDiagram
  participant H as Host daemon
  participant R as Runtime
  participant S as Records
  H->>R: tool call
  R->>S: note's deliveries become sent
  R-->>H: reply with the whole note
  alt a later step of the same attempt arrives
    H->>R: step after the reply's call id
    R->>S: delivered
  else turn ends first
    H->>R: turn ended
    R->>S: back to waiting, reason resend
  end
```

**Evidence is correlated, not assumed.** A later host event counts only if it is a step of the same attempt that comes after the reply’s call id in the host’s own order. Buffered events from before the reply, or a parallel subagent’s events, don’t count. When the order can’t be established, the record stays `sent` until the attempt settles and is then labeled as uncertain and resent.

**A code change:** today the kept copy is cut at `KEPT_REPLY_CHARS`, 2,000 characters (`server/remote/turns-tools.mjs:50`, `turns-shared.mjs:20`), so a long note would be cut. Under this design the kept copy stores the note in full and cuts only the rest of the reply, and the note itself is bounded by MD-3’s cap. This is the one per-route exception to “Delivering a turn”’s rule (DL-3, DL-8).

### 7.5 Context loss (CX-4)

| Signal | Backend | Effect |
|---|---|---|
| `compact_boundary` (`server/adapters/claude-stream.mjs:514`) | Claude Code | The next envelope says earlier messages may have been summarized, and points to `read_conversation`. |
| Missing session, agent restarted fresh | Kiro, Antigravity | The marker resets, so recent background is sent again. |
| None yet | Codex | It keeps its own thread. Codex 0.164.0 has `thread/compact/start` in its stable schema, so #425 can be wired up now; until then, no signal. |
| None yet | Agent SDK | No signal recorded yet |

Other signals are added only when a recorded turn shows one.

## 8. What reaches agents

Decided (8.5): any change to an item reaches the agents it concerns, as `notify`, which starts no turn. Each change raises the item’s `rev`.

| Change | Reaches | Mode |
|---|---|---|
| A message or block that mentions an agent | The agents it mentions; in a topic thread, its owner (MD-6) | wake |
| An answer to a block | The block’s author | as today: a wake to the waiting agent |
| An edit, shown as a diff | The item’s author and its recipients | notify |
| A review verdict, a thread outcome | The item’s author and its recipients | notify |
| A reply in a topic thread | The thread’s owner, as #472 records | wake |
| A reply in a topic thread, to a root author who isn’t the owner | That author | notify |
| A reaction, 🚩 included | As `reactionLines` today: the person’s reactions reach the agents answering in that thread; an agent’s reaction reaches only the agent whose message it is | notify |
| A room note approved or retired (#516 NT-3, NT-4; reserved) | Every agent in the room, running sessions included | notify, from `postbox` |
| An asset published (#516 UI-2; reserved) | The agents the asset’s thread concerns, as an edit does | notify |

- **Two routes to one change make one record** (INV-3). A root author who owns the thread gets the wake only.
- **MD-3’s cap per sender** covers reactions and amendments, so one busy message can’t flood its author’s catch-up.
- **🚩 still reaches agents** (person’s decision, 28 October). Intent’s telemetry row says *recording* changes nothing in an agent’s input; it doesn’t hide reactions.
- **Who an edit or verdict concerns** (its author and recipients) is this design’s reading. It needs confirmation.

## 9. Interfaces

### 9.1 Store events

| Event | Data | Reducer | Change |
|---|---|---|---|
| `record` | a whole open record | `state.records[id] = d` | New; written by `commit` as a document plus a stream entry |
| `record.close` | `{ id, state, at, reason? }` | `delete state.records[id]` | New; written by `commit` with its receipt entry (“Receipts”) |
| `session.patch` | `{ id, patch }` | `Object.assign` | New. Replaces whole-session `session` events from `updateSession`. In the browser, `client.mjs` applies it and then notifies listeners as a `session` change carrying the whole updated session, so the ten `app/js` modules that test `ch.type === 'session'` and read `ch.data.threadId` (`agents.mjs:56`, `thread.mjs:335`, `shell.mjs:295`, `open-asks.mjs:58` among them) keep working unchanged. |
| `item.add` | adds `item.n`, `item.rev` | as today, plus `thread.nextN` | Changed |
| `item.move` | adds the new `n`; the stub takes the old one | On the server, as today. In the browser, when the window doesn’t hold the item (`findIndex` gives `-1`, `shared/state.mjs:107`), the reducer breaks without an error, as today, and the window module, which also hears the event, fetches the item by id from the items API and places it by `n` when the window reaches the end. | Changed |
| `item.patch` | adds `rev` when the change is deliverable | drops a patch older than the item’s `rev` | Changed |

`thread.queue`, `schedules` and `se.context` stop being written once steps A3, A4 and A2 ship. Their events still replay from old logs during the one-time import (“Migration, compatibility and rollback”). In Redis every event is one entry in the `events` stream, whose id is the event’s `seq`; the browser’s stream and `Last-Event-ID` are unchanged.

**Reserved for #516:** `asset` (an asset header: id, name, type, author, scope, versions `[{ v, hash, base, author, at }]`) and `asset.version` (one more version, written by `commit` as a script that checks the base version under `WATCH` in the same transaction). The reducer keeps headers in `state.assets`, a map by id like `state.apps`; content lives in the blob store by hash (`architecture.md`, “The store”, Attachments), never in Redis. Neither event is emitted by this design.

**Host protocol.** A host’s kept reply becomes `{ note, text }`: the note in full, and the rest cut at `KEPT_REPLY_CHARS` (step A2).

### 9.2 HTTP

| Route | Request | Response | Change |
|---|---|---|---|
| `GET /api/state` | — | Everything but items: projects, personas, sessions, thread headers, app headers, glossary, open records | Changed |
| `GET /api/threads/:id/items` | `anchor` (`newest` or an item id), `before`, `after` | `{ items, work, foundOldest, foundNewest, seq }`, at most the calibrated page size | New |
| `GET /api/stream` | `open` (a list of conversation ids), `Last-Event-ID` | Events; item and step events only for `open` | Changed |
| `GET /api/threads/:id/search` | `q` | Hits: `{ id, n, handle, at, snippet }` | New, with B3 |

### 9.3 Agent tools

| Tool | Change |
|---|---|
| `read_conversation`, `read_message` on hosts | Answered from the snapshot when it can; otherwise the host asks Postbox. “Unavailable” stays distinct from “not found”. |
| `react` | No change |
| `wake_agent` | No change in this design (removed later by #481) |

## 10. Browser

- **State:** thread headers, app headers, sessions and open records for every conversation. Items only for open conversations.
- **The window** is one contiguous range of items per open conversation:
  - Scrolling near its top loads the page before it.
  - Reading far back may unload from the far end, if measurement shows PF-1 needs it. The range stays contiguous.
  - A jump (an `m=` link, “Next needs you”, an open ask) replaces the range with the page around the target (PF-4).
- **The view state comes first** (approved design, change 3). It is either following the newest item, or reading at `{ anchorId, offset }`. Only the person’s input changes it, and every DOM change re-applies it. Its tests are the 13 scroll issues that change lists (PF-3).
- **Speaker grouping and stubs** compare neighbors by `n`, not by list index.
- **One reader:** only the window module reads `state.items` (INV-8). Every other module reads records or headers.
- **A watermark per loaded projection.** Today one `client.seq` gates every event (`app/js/client.mjs:78-82`). With pages loaded at different times that gate is wrong both ways: it would drop valid events for a window loaded behind the headers, and a page’s own `seq` alone would let a replay apply a text chunk twice. So each independently loaded projection keeps its own last-applied `seq`: the headers and records together, each window, and each window’s work list. An event applies to a projection only if its `seq` is greater than that projection’s watermark, and then advances it. The server keeps one global sequence; nothing is added on its side.
- **Page requests carry a generation.** A response whose generation is older than the window’s current one is dropped, so a slow page can’t replace a newer jump or resync.
- **Interactive state survives unmounting (#494).** `app/js/rerender-state.mjs` already keeps unsent review comments, expanded activity and raw fallbacks across live updates, keyed by item id outside the DOM. The window keeps that state through eviction and restores it on remount. An item that holds focus, a dirty review or form, or an app frame with unsent input is never evicted; it pins the range’s edge until the interaction ends. App version and reset semantics are unchanged by eviction: an evicted frame remounts at its current version.
- **Finding a message (PF-8).** The window breaks the browser’s find-in-page for anything not mounted, as the integrator review noted. So B3 ships the person’s search box with it: `GET /api/threads/:id/search?q=` builds a BM25 index over the conversation’s items when asked (`shared/bm25.mjs` already has `buildIndex` and `search`), and a hit is a jump (PF-4). The agent tool stays a non-goal.

**Opening or switching conversations**

```mermaid
sequenceDiagram
  participant B as Browser
  participant S as Server
  B->>S: GET items for the conversation
  Note over B: queue live events meanwhile
  S-->>B: page with its seq
  B->>B: apply queued events above the window's watermark
  B->>S: reconnect stream with the new open list, from the lowest watermark
  S-->>B: replay, then live events
  B->>B: each projection takes only events above its own watermark
```

On `resync`, the browser refetches `/api/state` and each open window.

## 11. Observability and calibration

**Metrics (MS-1).** A script reads the receipts (“Receipts”) of a room, from its Redis or from a copy of its data folder, and reports over the retained window:
- delivery completeness within deadline T, with every opened record in the denominator;
- labeled and unlabeled repeats (INV-4), from `resent` lines against `attempt`;
- lag from `waiting` to `delivered`, p50 and p95;
- blocked records, each with its sender, recipient and attempts.

It needs no state, so it runs the same on a copy, and its counts don’t change across a snapshot and restart.

**Calibration (MS-3, proposed).** Each tuning setting is one named entry in `shared/limits.mjs` with its draft value, the metric that judges it and the method that sets it. Each value cites a dated report from copied rooms. A check fails on a tuning value without a report.

| Setting | Draft | Judged by | Method |
|---|---|---|---|
| Window size, in items and mounted DOM nodes | 200 items | Key-to-frame p95; Safari’s idle painting | Try 50 to 800 on copies of three rooms; keep the largest within budget; never less than three screens |
| Page size and prefetch distance | 60 | Stalls in a recorded scroll; page fetch p95 | Prefetch at p95 scroll speed × p95 fetch time |
| Unloading from the far end | Only if needed | Mounted DOM nodes while reading back | Kept only if reading back exceeds the budget |
| Catch-up size | 40 items, 16,000 characters | Completeness; envelope share of the prompt | Several sizes on copies |
| Delivery deadline T | Not set | Delay from waiting to delivered | The baseline’s p99.9 |
| Open notifications per recipient (`openNotifies`) | 20, today’s `tellAgent` cap, so A2’s tests run before any report | Size of `/api/state` with an idle agent; notifications folded | From a copy of a busy room |
| Host timeout for `sent` records after a restart | Not set | Resends with no failed turn behind them | From recorded host reconnects |
| `maxResends` before a record is blocked | 3 (decided) | Blocked records that a later turn would have delivered | From the receipts of copied rooms |
| `receiptsKeep`, closed receipts kept | 50,000 | Whether MS-1’s window covers a room’s recent weeks | From rooms’ receipt rates |
| Write round trip: added latency per streamed chunk and per `commit` at dispatch, on the bundled Redis against today’s store | Not set | Turn-start time and streamed-text lag on a copy of this room | Measured in the Store step before anything else moves |
| Stream retention: entries kept in `events` before trimming | Not set | Browsers that needed `resync` after a reconnect | From rooms’ event rates and typical reconnect gaps |

**Budget (PF-1, decided):** key-to-frame p95 within 10% of a small room’s, and Safari’s idle painting no higher, on copies of real rooms.

## 12. Failure modes

| Failure | What happens | Requirement |
|---|---|---|
| A turn fails before any output | Its deliveries return to `waiting`, labeled as resends; the marker doesn’t move | DL-1, DL-3, INV-6 |
| A turn fails after output | Its deliveries stay `delivered`: the model read the prompt | DL-2 |
| Postbox stops with a local turn’s deliveries `sent` | At startup they return to `waiting`, labeled; because `sent` was committed before dispatch, the label is never missing | DL-1, INV-1, INV-12 |
| Redis refuses or fails a write at a dispatch boundary (disk full, process gone) | Nothing was applied or seen; the turn doesn’t start; records stay `waiting`; the session shows the error | DL-1, INV-12 |
| Redis or Postbox is killed during a `commit` | The script is atomic: either every key and the stream entry were written, or none; a repeated `commit` finds no `opId` and runs once | INV-12, INV-1 |
| The Redis child fails to start, or dies | Writes fail closed; the page stays readable from memory; in-flight turns stop and their records return to `waiting`, labeled; one status line names the cause with Retry (decision 7) | DL-1 |
| A power cut within the last second | Up to a second of writes is lost (`everysec`); a resend after it may lack its label. Stated limit (decision 3) | INV-12, stated exception |
| The pinned download fails on first start | Postbox doesn’t start the store, shows the failure and the URL, and retries; nothing is written anywhere else | — |
| Postbox starts on macOS on Intel or on Windows | Postbox refuses to start before downloading anything, and says the platform isn’t supported and which ones are | — |
| A message is edited while its turn is in flight | The attempt settles `sentRev`; the newer revision stays owed as an amendment with a diff | DL-2, DL-7, INV-13 |
| A record can’t be delivered after `maxResends` attempts | It is blocked and the person gets an ask naming it | DL-1, AT-1 |
| The `events` stream is trimmed | Documents are unaffected; a browser behind the trimmed window gets `resync`; receipts have their own retention | PF-5, MS-1 |
| Two windows are open at different `seq`s | Each applies only events above its own watermark | PF-5 |
| A turn fails after output with a transient error | A labeled delivery asks the agent to check what ran; a lost scheduled wake is retried this way | SW-2 |
| A message is edited while it waits | Its waiting record takes the newer revision; it arrives once | DL-2 |
| An idle agent collects notifications | Past `openNotifies` they fold into one record with a count | INV-7 |
| Postbox stops while a host turn runs | Its `sent` records wait for the replayed stream, or the host timeout | DL-1, MS-1 |
| More than 20 notices wait for an agent | All are kept; MD-3 folds them in the envelope | DL-1 |
| The person doesn’t allow a held wake | The held deliveries expire and their senders are told | AT-1 |
| A host’s link drops after a reply with a note | The note stays `sent` until the replayed stream shows the turn going on; the kept copy holds the whole note | DL-3, DL-8 |
| A limit holds a wake while a card is open | A second record waits with `reason: held` and `heldBy`; nothing is dropped | AT-1, AT-2 |
| A request is settled another way | Its ask is withdrawn; nothing is delivered twice | AT-3 |
| The browser falls behind the backlog | `resync`: refetch headers and windows | PF-5 |
| Events arrive during a page load | Queued, then applied if newer than the page | PF-5 |
| A block is revised far above the window | The reducer’s `item.move` finds nothing and breaks, as today (`shared/state.mjs:107`); the window module fetches the item by id and places it by `n` | PF-6 |
| A host runs an older protocol | The handshake fails with the `version` failure and the host’s agents show as unavailable until it is updated; nothing is delivered to them | CX-2, DL-8 |
| Downgrading Postbox after the Store step | An older Postbox doesn’t read Redis, and a newer document shape can’t be read by older code (decision 5); the dated backup restores the JSONL log and snapshot. See “Migration, compatibility and rollback”. | — |

## 13. Migration, compatibility and rollback

- **Storage (Store step):** at first start, Postbox downloads and starts the pinned Redis 8, reads `snapshot.json` and the JSONL segments as today, writes every document and the stream in batches, and renames the old files `*.migrated` beside a dated backup. The import is idempotent: a store that already holds the snapshot’s `seq` is left alone. Startup then reads only Redis. A room copied for tests is a copy of the data folder.
- **Value shapes:** never migrated. Each document carries `v`, and readers upcast (decision 5).
- **Positions:** numbered when a snapshot loads (“Items: position and revision”). No versioned migration.
- **`se.needs` → asks (A1):** at startup, each session’s `needs` of an ask kind becomes an open ask record, and `needs` is cleared. Readers move to `shared/records.mjs` in the same step.
- **`se.context` → deliveries (A2):** at startup, each notice becomes a notice item (“Postbox notices as items”) and a `notify` delivery from `postbox`, urgent ones with `urgent: true`, and `context` is cleared, all in one `commit`. The conversion is idempotent: a notice that already has an item is skipped.
- **`thread.queue` → deliveries (A3) and `schedules` → deliveries (A4):** the same pattern, one step each.
- **Hosts:** the read contract raises `PROTOCOL_VERSION` from 2 to 3 (`shared/remote-protocol-constants.mjs:8`). Both ends of the handshake reject a mismatch (`server/remote/ssh-connection.mjs:169`, `server/remote/host/daemon-hello.mjs:30`), so there is no mixed-version mode: a host on 2 fails to connect with the existing `version` failure (“It speaks protocol 2; this Postbox speaks 3”), its agents are unavailable until the host’s Postbox is updated, and nothing is delivered to them meanwhile. That is deliberate: one version at a time, as today (decided 28 October). It conflicts with #464 (“Updating Postbox should not strand agents on remote hosts”, P2): under this decision, every agent on a protocol-2 host is unavailable from the person’s update until that host updates. So the remote read contract’s release notes say which hosts to update and how, and #464 gets a comment recording the decision. A v2-against-v3 handshake test covers the message.
- **Rollback:** an older Postbox reads neither Redis nor `record` and `session.patch` events, and a newer document shape isn’t readable by older code. The dated backup made at the Store step’s first start is the way back, and the release notes say so. Every step after that adds no new event type or document shape unless it says so.

## 14. Rollout

```mermaid
flowchart TD
  N["Now: ring fix, session.patch, issue 515, task-first envelope"]
  S["Store: bundled Redis 8"]
  A1["Step A1: ask records"]
  A2["Step A2: deliveries, turn outcome, marker"]
  A3["Step A3: the person's queue"]
  A4["Step A4: scheduled wakes"]
  L["Later: notify and wake modes"]
  N --> S --> A1 --> A2 --> A3 --> A4 --> L
```

```mermaid
flowchart TD
  N["Now: ring fix, session.patch"]
  RC["Remote read contract"]
  B1["Step B1: positions, view state"]
  B2["Step B2: items API, filtered stream"]
  B3["Step B3: the window, calibrated"]
  A1["Step A1: ask records"]
  N --> B1 --> B2 --> B3
  A1 --> B3
  N --> RC
```

**Definition of done, for every step.** Three things, in this order, as `tests/uat/e2e/README.md:7` puts it: a run confirms a fix; it doesn’t decide it.
1. **Its specs pass.** Requirements, “Acceptance, test first”, names, per requirement, the `node:test` or Playwright spec (layer 1) or the recorded-turn conformance fixture (layer 2) that decides it. Each is written first and fails on `main` before the step starts (MS-2). The step’s pull request shows that failing run.
2. **Its phase’s triggers fire.** In a real-agent run of `delivery.md` or `bigroom.md`, the phases that name the step record each of their triggers, which proves the code path ran.
3. **Its phase’s checks stay silent,** on every backend in the step’s scope. `delivery.md` runs four times, with the agent under test on Claude Code, Codex, Kiro and Antigravity (DL-8); phase 7 runs on Claude Code only until #425 is wired.

**Test infrastructure comes first in each step.** The triggers, checks, the `big-room` seed and `tools/uat/fault-launcher.mjs` that a step’s phase needs are built at the start of that step and run against `main` before the step’s code. On `main` today, `delivery.md` phase 1 should record `ask-dropped` (#439) and phase 2 `delivery-dropped` (#484); if they don’t, the check is wrong, not the room.

| Step | Contents | Depends on | Decides: specs, failing first | Confirms: scenario phase, triggers, checks silent |
|---|---|---|---|---|
| Harness | Triggers and checks for A1 and A2 (`held-behind-card`, `held-released`, `mention-past-cap`, `edit-while-waiting`, `fail-before-output`, `resend-labeled`; `ask-dropped`, `delivery-dropped`, `unlabeled-repeat`, `marker-before-output`, `needs-mismatch`); the `big-room` seed; `fault-launcher.mjs` behind `POSTBOX_CLAUDE_BIN`, `POSTBOX_CODEX_BIN`, `POSTBOX_KIRO_BIN` and `POSTBOX_AGY_BIN` | — | Each check has a unit test on a recorded room where it fires and one where it stays silent | `delivery.md` phases 1 and 2 on `main` record `ask-dropped` and `delivery-dropped` |
| Store | The Redis 8 child: Postbox’s CI build of 8.10.3 for macOS arm64, Linux arm64 and Linux x64, hosted with its source; pinned download with checksum; a refusal to start on an unsupported platform; process supervision, config and data under the data folder; `server/store.mjs` on Redis (“Storage”): documents, the `events` stream, `ops`, plain indexes; `emit` pipelined, `commit` as atomic scripts with publish-after-reply; `everysec`; fail-closed-read; the one-time import | — | First specs: the downloaded build matches its pinned checksum, and the hosted source matches the official tarball’s SHA-256; an unsupported platform is refused before any download, with its message; the whole existing suite passes on Redis unchanged; importing a copy of this room gives a state equal to today’s; a kill during a `commit` leaves documents and stream consistent; a failed `commit` leaves state and clients unchanged; the child failing to start or dying shows the status and holds writes; two processes against one Redis keep every transition consistent; write round trips on a copy of this room are within the “Observability and calibration” budget | None: no scenario phase; it changes no behavior an agent or the person can see |
| Now | #463’s ring fix; `session.patch`, with `client.mjs` re-emitting it as a whole-session `session` change; #515’s constant system prompt; the task-first envelope | — | PF-2’s paint-count spec with one agent working; live session events in a copy of this room average under 1 KB; every `session` listener in `app/js` passes unchanged; #504’s and #515’s specs | `thread-focus.md`: `thread-request-first` silent (DL-4, #511) |
| A1 | Ask records; `card.held` becomes deliveries with `heldBy`, keeping `HELD_WAKES`; the Add card as an ask that holds (AT-7); derived needs-you and open asks | Harness; Store | #439’s and #326’s cases; INV-10; AT-7’s held Add card; needs-you counts with a room’s items not loaded; today’s held-wake tests unchanged | `delivery.md` phase 1: `held-behind-card`, `held-released`; `ask-dropped`, `needs-mismatch` silent |
| A2 | Deliveries; `se.context` as deliveries; the turn-outcome rule and outcome matrix; the marker; INV-9; INV-11; the transient-failure resend; folding; the host note rule and kept-copy change; `settle` on `commit`; `sentRev` and amendments; the receipts table; notice items; CX-4’s compaction notice | A1; Harness; a recorded failing turn and the turn after it, per backend; `fix/466-wake-retry` merged or carried | #484’s cases including the oversized oldest mention; edit before output, after output, late settle; crash between `emit` and append; 21 notices folded and recovered after snapshot and restart; v2 host against v3; receipts counts across snapshot and restart; the outcome matrix from recorded turns; a recorded `compact_boundary` makes the next envelope say so; unlabeled repeats 0 on a copy of this room | `delivery.md` phases 2, 3, 4 and 7, on all four backends (7 on Claude Code): `mention-past-cap`, `edit-while-waiting`, `fail-before-output`, `resend-labeled`, `urgent-note-delivered`, `compaction`; `delivery-dropped`, `unlabeled-repeat`, `marker-before-output`, `wake-text-clipped`, `context-loss-unannounced`, `thread-leak` silent |
| A3 | The person’s queue as deliveries | A2 | Edit, Remove and Send now on each queued message; none superseded; ten fold into one row (Playwright) | `delivery.md` phase 5: `person-queue-three`; `queued-superseded` silent |
| A4 | Scheduled wakes as deliveries; a demo-only route that drops a host’s link for a set time, over `dropLink` (`server/remote/hosts-links.mjs:99`), for the runner | A2 | #458’s cancel by id, including after a host replay (#498’s test); #466’s wake lost to a drop retried with its label; `restart-mid-host-turn` as a node test alone, since no runner action restarts Postbox mid-run | `delivery.md` phase 6, local and on a host: `wake-scheduled`, `wake-canceled`, `wake-after-drop`; `delivery-dropped`, `unlabeled-repeat` silent |
| Remote read contract | Host reads fall back to Postbox; `PROTOCOL_VERSION` 3 | #489 for Kiro | CX-2: `read_conversation` reaches the first item, locally and on a host; the v2-against-v3 handshake test | None: no scenario phase; conformance decides it |
| B1 | Positions; the view state | — | The 13 scroll regressions (Playwright); the replay numbering test | `bigroom.md` phase 1: `window-paged-back`; `view-moved` silent |
| B2 | Items API; filtered stream; per-projection watermarks; page generations | B1 | A page fetched during patches; a move from an unloaded page; a reconnect after a snapshot; switching; two windows at different `seq`s with a replayed chunk; an out-of-order page response | `bigroom.md` phases 2 and 3: `jump-outside-window`, `needs-far-back`, `move-from-unloaded`; `needs-jump-missed`, `needs-mismatch`, `updated-app-far-up` (extended to blocks) silent |
| B3 | The window; the person’s search box (PF-8); interactive state across eviction | B2; A1 (INV-8 needs `shared/needs.mjs:26` and `app/js/open-asks.mjs:25` off items); #495 merged (`app/js/app-check.mjs` reads `client.state.apps`, which is what makes PF-7 hold without items); calibration reports | PF-1’s budget on copies of three rooms; INV-7 and INV-8; search outside the window; an app in an unopened thread checked while a page is open and pending when none is; an unsent review paged out and back keeps draft, focus and expansion | `bigroom.md` phase 4 and the run as a whole: `search-outside-window`, `switch-conversations`; `stream-gap-or-dup`, `page-errors`, `check-starved` silent |

PF-1 and PF-2 have no scenario phase: real agents add noise and nothing to measure, so their Playwright specs on seeded rooms decide them alone. MD-1, MD-4 and MD-5 get their phases with the later modes step, and AT-5 with #492.

Every step keeps the full browser suite green and passes the size check (INV-7). Track B is independent of Track A up to B2; B3 needs A1, because two item readers it must retire (`shared/needs.mjs:26`, `app/js/open-asks.mjs:25`) are the ones A1 replaces.

**Two things critic left unverified, now checked on `main` at v0.42.3:**
- **Every backend has an executable override,** so the fault launcher can stand in for each CLI: `POSTBOX_CLAUDE_BIN` (`server/adapters/claude-code.mjs:46-48`), `POSTBOX_CODEX_BIN` (`codex-models.mjs:5`), `POSTBOX_KIRO_BIN` (`kiro-cli-models.mjs:6`) and `POSTBOX_AGY_BIN` (`antigravity-cli.mjs:69`). A2 needs no new setting.
- **Nothing lets the runner cut a host’s link on cue.** `dropLink` exists (`server/remote/hosts-links.mjs:99`) and `/api/demo/offline` cuts only the browser’s streams (`server/index.mjs:494`). A4 adds a demo-only route that calls `dropLink` for a set time; it is in A4’s contents above.

**`designs/` changes, made with the steps they describe**

| File | Section or row | Change |
|---|---|---|
| `architecture.md` | The store | Persistence moves onto a Redis 8 server that Postbox bundles and runs, as the section’s revisit line named Redis Streams; documents are the truth and the stream the sequence, written together; values upcast on read; `everysec` with its stated limit; fail closed for writes. The event model and reducer stay; snapshots go. `commit` is the atomic, publish-after-reply write for lifecycle transitions; `emit` stays optimistic for streamed text. The browser’s state stops being a full projection: headers and open records everywhere, items per window. |
| `engineering-practices.md` | “Keep runtime dependencies at zero” | One exception, stated: a managed native binary, Redis 8, that Postbox builds in its CI, downloads pinned, verifies and supervises; taken under AGPLv3, with the matching source offered with each release. No npm package. |
| `architecture.md` | The front end | The transcript is a window with an explicit view state. |
| `architecture.md` | A conversation is shared memory | The marker moves on output; deliveries are records; the revisit line becomes “count and cursor”. |
| `intent.md` | Attention, “Only one wake waits for your confirm at a time” | Several can wait (A1). |
| `intent.md` | Attention, `wake_agent` | Changes when #481 ships, not in this design. |
| `intent.md` | Not in scope, “Search across threads” | Moves into scope when the search issue ships. |

## 15. Verification

| Area | Requirements | Layer that decides | Tests |
|---|---|---|---|
| Records and lifecycles | DL-1–3, DL-6, AT-1–4, AT-6, AT-7, SW-1–3 (SW-2 by the transient-failure resend) | Spec | Reducer and `shared/records.mjs` unit tests for every transition in “Record lifecycles” and for INV-1 to INV-3 and INV-10; #439, #326, #484 and #374 as cases; the Add card held as an ask |
| Positions on replay | PF-6, INV-5 | Spec | Replaying a pre-upgrade log with `item.add` and `item.move` gives the numbering in “Items: position and revision” |
| Turn outcome | DL-3, DL-8 | Conformance | One recorded failing turn and the turn after it per backend, as fixtures; a test per backend that a failure before output leaves deliveries waiting |
| Outcome matrix | DL-3, DL-8 | Conformance | One row per outcome in “Delivering a turn”, from recorded events of each backend; `blocked` after `maxResends` |
| Mid-turn delivery | MD-2, DL-2 | Spec + conformance | The urgent note is delivered when its tool result returns and the turn continues, locally and from a recorded host turn |
| Host note and restart | DL-3, DL-8, MS-1 | Spec + conformance | A link dropped after a reply; a turn ended before the stream continues; a note over 2,000 characters survives a repeat; Postbox restarted mid host turn (node test alone) |
| Envelope | DL-2, DL-4, DL-5, CX-3 | Spec + conformance | #504’s prompt-order check and real-agent run; #515’s resumed-session check; INV-9 with #484’s mention |
| What reaches agents | DL-7, MD-3, MD-6, MD-7, CX-1 | Spec | A topic-thread reply wakes its owner; a root author who isn’t the owner gets one notify; a waker’s second post supersedes its queued wake without a mention; reactions follow `reactionLines`’ audience; the cap folds; nothing from a thread enters another agent’s envelope unless read or sent |
| Context loss | CX-4 | Conformance | A recorded `compact_boundary` makes the next envelope say context may have been summarized; a fresh Kiro or Antigravity session resets the marker |
| Durability | INV-12, INV-13 | Spec | Redis killed during the dispatch `commit`; a refused or disk-full `commit` leaves state and clients unchanged; a repeated `commit` with the same `opId` writes once; a conversion killed mid-way leaves nothing; edit before output, after output, and a late settle from an old attempt |
| Store | INV-12 | Spec | The existing suite on Redis; import of a copied room equals today’s state; the child failing to start or dying fails closed with the page readable; two processes against one Redis keep transitions consistent; receipts commit with their event or not at all; an old-shape document upcasts on read |
| Receipts and metrics | MS-1 | Spec | Counts unchanged across a restart; completeness counts an opened-but-never-closed record; pruning never touches an open record; the script’s counts on a small fixture match a hand count |
| Calibration | MS-3 | Spec | A tuning value in `shared/limits.mjs` without a dated report fails the check |
| Protocol | CX-2, DL-8 | Spec | A v2 host against v3 fails with the `version` message; agents show unavailable |
| Remote reads | CX-2 | Spec + conformance | `read_conversation` reaches the first item, locally and on a host |
| Browser: view and window | PF-1, PF-2, PF-3–6, PF-8 | Playwright spec | The 13 scroll regressions; paint count with one agent working; jumps; switching; resync; INV-8 lint; search outside the window |
| Bounds | INV-7 | Playwright spec | `/api/state` size on a copied room with many closed records and an idle agent past `openNotifies` |
| Interactive state | PF-3 | Playwright spec | An unsent review paged out and back keeps draft, focus and expansion; a focused item is never evicted |
| App checks | PF-7 | Playwright spec | #495’s specs: an app in an unopened thread is checked while a page is open, pending when none is |
| Delivery, confirmed | DL-1–3, DL-5–8, MD-2, AT-1–4, AT-6, SW-1–2, CX-1, CX-4 | UAT-confirm | `delivery.md`, seven phases, four backends: each phase’s triggers fire and its checks stay silent |
| Big room, confirmed | PF-3–8, AT-4 | UAT-confirm | `bigroom.md`, four phases: each phase’s triggers fire and its checks stay silent |

Specs and conformance fixtures decide; a UAT run confirms. Fixtures come from recorded turns and copied rooms, and each notes its source. The `big-room` seed is generated, not copied from a real room, so no project content reaches the tester model.

## 16. Alternatives considered

| Alternative | Why not |
|---|---|
| Three record systems: open requests, delivery records and message records (approved design, changes 2, 7 and 9) | Three lifecycles for one concept, beside four existing partial ones. One collection with two kinds covers every requirement in section 15. |
| A per-backend `accepted` event (approved design, change 7) | Depends on four CLIs’ stream formats, which change between versions, and has no answer for a missing event. The turn’s outcome is already reported by every adapter. |
| At most once: count a failed turn’s deliveries as delivered | Can lose a message, against intent principle 2. Rejected (decision 8.2). |
| A new item for each revision | Changes ids that reactions, threads, Work rows and `react` depend on (`shared/mcp-tools.mjs:107`). |
| A window with gaps | Complicates grouping, stubs and resync. A contiguous range with far-end unloading meets the same budget. |
| A cursor per stream subscription | The global `seq` with a filtered backlog already resumes correctly. |
| Keeping closed records in state | Grows `/api/state` with a room’s age, which brings back the problem the window removes. |
| Closed records only in the event log (revisions 2 to 5) | A snapshot deletes the segments it covers (`server/store.mjs:131-136`), so the history would vanish. Changed to a receipts journal in revision 6, then to receipts written in the same transaction in revisions 10 and 11. |
| A separate receipts file (revisions 6 to 9) | Two files that must agree: a crash between the event and the receipt loses or invents history, and two rotations can split a record’s rows. Replaced by receipts in the same transaction (“Receipts”). |
| A metrics projection in `store.state` | Grows with history. Revision 6 also said it “would ship in `/api/state`”, which was a false constraint: what the server stores and what it sends are independent. The real objection is only size; server-only documents keep the facts bounded by retention. |
| JSON Lines plus our own transaction framing | See “Storage”: a transaction engine written and tested only by Postbox, to keep a format chosen for being simple. |
| SQLite through `node:sqlite` (revision 10) | A relational schema is its natural shape and the one that stopped an earlier Postbox with migrations between versions; synchronous writes block the event loop; a single-process design by nature. Rejected on the person’s constraints (“Storage”). |
| Redis 8 without its JSON and search | Serves every lookup this design has, but agent search would stay BM25 inside Postbox and partial updates would rewrite whole values. The person chose Redis 8’s JSON and search from the start (decision 6). |
| `appendfsync always`, or `WAITAOF` before dispatch | Power-failure safety for every write, or for dispatch alone, at an fsync per write or a barrier per turn. The person chose `everysec` and the stated one-second limit (decision 3). |
| The person installs Redis | A new install step and a failure the person must handle; Postbox bundling it keeps zero setup (decision 1). |
| Keep writing to memory when Redis is down and reconcile later | A second write path, and a crash in the gap loses the writes. Fail closed for writes instead (decision 7). |
| Multi-version host protocol | Both handshake ends reject a mismatch today; supporting two versions is a new feature with its own tests. One version at a time stays. |
| Automatic retry on a timer | Turns at-least-once into a loop against a broken backend; resends happen only on the next turn, and stop at `maxResends`. |
| Rebuilding state from the stream at startup, as today | Needs snapshots and replay; with documents as the truth, startup reads keys and the stream is only the sequence (decision 4). |
| Indexes on records by recipient and by `(to, sourceId)` | Open records are bounded, so a scan is cheaper than keeping indexes current. Revision 3 proposed them; dropped on critic’s review. |
| Including the revision in the record key | Lets one recipient hold two open records for one item, so an edit while it waits arrives twice. Revision 3 did this; changed on researcher’s review. |
| An incremental search index | The person’s search box builds an index per query with `shared/bm25.mjs`. An incremental one waits for a measurement that shows it’s needed. |

## 17. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A backend reports a turn’s failure in a way the adapter misreads as output | Medium | The per-backend recorded failing turn becomes a fixture (A2) |
| Labeled resends confuse agents | Low to medium | The label’s wording is covered by #504’s real-agent check |
| The view state doesn’t fix every scroll issue before B3 | Medium | B3 depends on B1’s 13 regression checks passing |
| Moving `needs` readers misses one | Medium | INV-8’s lint, and A1’s check with items not loaded |
| A `tellAgent` caller depends on the cap of 20 | Low | Each of its 15 call sites is reviewed in A2 |
| A downgrade after records exist, or after a newer document shape is written | Low | Backup before first start (“Migration, compatibility and rollback”); release notes say downgrade is unsupported past the Store step |
| The first-start download fails or is slow | Medium | Postbox shows the failure and retries; the Store step tests an offline first start |
| Supervising a native child process, and building it, on three targets | Medium | One supervisor module with tests for failed start, port in use, death mid-turn and clean exit; CI builds and tests the pinned version on each target before release |
| A power cut loses up to a second of writes (`everysec`) | Low | A stated limit of INV-12, chosen by the person; the resend label covers every other case |
| Write round trips add latency to streamed text or turn start | Low to medium | `emit` is pipelined, one `MULTI` per tick; measured in the Store step against the “Observability and calibration” budget |
| Remote agents are unavailable until every host is updated to protocol 3 (#464) | Medium | The read contract ships with release notes naming the host update; the `version` failure says what to do; #464 records the decision |

## 18. Decisions

| Date | Decision | By |
|---|---|---|
| 28 Oct | The window’s budget is parity with a small room | Person |
| 28 Oct | Search scope: the conversation and its side and topic threads; index in memory; no new dependencies | Person |
| 28 Oct | Standing decisions: Postbox proposes, the person approves each | Person |
| 28 Oct | 8.2: at least once, with every resend labeled | Person |
| 28 Oct | 8.5: any change to an item reaches the agents it concerns, as notify | Person |
| 28 Oct | 8.6: drop “seen” | Person |
| 28 Oct | 🚩 keeps reaching the agent whose message it is | Person |
| 28 Oct | Protocol: one version at a time; a v2 host is unavailable until updated (gpt-16; conflicts with #464, recorded there) | Person |
| 28 Oct | `maxResends` is 3; a blocked message stays an open ask until the person answers | Person |
| 28 Oct | Storage: a Redis 8 server that Postbox bundles and runs; pinned download at first start; `appendfsync everysec`; documents plus stream in one transaction; values upcast on read; Redis 8’s JSON and search from the start; fail closed for writes with the page readable; every transition atomic so a second process can follow (“Storage”, eight decisions) | Person |
| 28 Oct | The data model is key/value or document, never a relational schema | Person |
| 28 Oct | Redis 8.10.3, built by Postbox’s CI from the official source tarball and hosted with its source (revises storage decision 2); taken under AGPLv3 | Person |
| 28 Oct | Supported: macOS arm64, Linux arm64, Linux x64. Unsupported, refused at start: macOS on Intel and Windows | Person |
| 28 Oct | More than one process or person is likely within a year | Person |

## 19. Open questions

| Question | Blocks |
|---|---|
| A turn that fails before output has already saved its prompt on Codex and Antigravity (confirmed). Does the agent then see it twice on its next turn? One recorded pair of turns per backend. | A2 |
| Who does an edit or verdict concern: its author and recipients? | A2 |
| Rename the `notify` toast event to `alert` (8.7)? | The later modes step only |
| Can the UAT runner restart Postbox mid-run? If not, `restart-mid-host-turn` stays a node test alone. | A4’s confirmation only |

## 20. Extension points for room assets (#516)

#516 holds the approved requirements for room assets: one versioned store of files, notes and apps, reached through Postbox’s tools and through a room folder, local or on a host. Its design waits on two decisions (what to keep when a budget is full; the listing threshold). This section records which parts of this design it builds on, so that #516 extends them rather than adding a fifth mechanism. Nothing here is built by this design.

| #516 needs | This design provides | What #516 adds |
|---|---|---|
| A note proposal is an ask for the person, approval covers the exact text (NT-2) | `ask` records, `askKind: 'note'`, with `parts` holding the proposed text and `rev` its revision; the Allow route (“Record lifecycles”) | The note store that an approval writes to; the folder’s read-only `notes` file (NT-1) |
| Approved notes reach every agent’s turn, running sessions included (NT-3); a retired note stays as superseded (NT-4) | Envelope item 3’s reserved slot; `notify` deliveries from `postbox` to every session in the room (“What reaches agents”); a notice item per change (“Postbox notices as items”), so the fold cursor recovers it | The notes list itself, and its length cap under MS-3 |
| Every reference names an exact version (AS-5); a review takes an asset version (UI-3) | Items already carry `rev`; a record’s `(sourceId, rev)` key works for an asset id and version unchanged | A review item that points at `{ assetId, version }` instead of `{ itemId }` |
| One commit path, every write names its base (CM-1); a repeated write is one version (CM-6); a partial file is never published (CM-4) | `store.commit` with an `opId` (“Storage”): one atomic script that checks the base version under `WATCH`, writes the new version and records the operation, so a retry finds its `opId` and returns the same result. Content hashes deduplicate bytes; they don’t make a retried mutation idempotent, the `opId` does. The blob store by hash | `asset.version` through `commit`, with the base check inside the transaction: refuse a tool write (CM-2) or keep a conflict (CM-3). Blob bytes are written and verified before the reference commits; an unreferenced upload is cleaned up by a sweep, since a metadata transaction can’t commit an external file |
| Folder changes publish at the end of the turn and survive a failed turn or disconnect (RF-1, CM-5) | A turn-end hook, distinct from `settle`: `settle` runs at the turn’s first output (“Delivering a turn”), while publication belongs at the turn’s actual end. Pending publications keep their own small lifecycle and retry on their own; they don’t join the delivery state machine | The folder scan that finds changed files by hash, and the pending-publication list |
| A published change shows as one line with a diff (UI-2) | `item.add` with `n` and `rev`; the delivery rules in “What reaches agents” say who is told | The line’s text and the diff from the previous version |
| The Assets view works whatever part of the room is loaded (UI-1) | Headers in `/api/state`, like app headers (“What is state, what is in the store, and what reaches the browser”, PF-7); INV-8 keeps readers off items | `state.assets` headers, bounded by asset count and the retention rule, not by bytes |
| A host gets changed files at turn start and fetches large ones on demand; nothing new on a host reaches back (RF-2, IF-3, SC-7) | The remote read contract: answer from the host’s copy when it can, ask Postbox over the existing broker otherwise; `PROTOCOL_VERSION` 3 | The sync of changed hashes at turn start, and the 120 MB transfer with retry (TR-1) |
| Apps keep their lifecycle; the folder mirrors them read-only (AP-1, AP-2) | App headers in state; `update_app` as the only writer; #495’s checker | The read-only mirror in the folder |

**Two things this design does so #516 stays small:**
- The envelope has a slot for notes now, so adding them later changes no prompt order and needs no system-prompt change on resumed sessions (#515).
- `askKind`, the reserved event names and the reserved Redis keys are listed now, so #516 adds values, not shapes.

**Not reconciled here, by choice:** the budget and retention rule (SC-1, decision 10.1) and the listing threshold (RF-2, decision 10.2). Pending folder publications are their own lifecycle (above), not records, so they stay out of the delivery state machine; #516 designs them against the turn-end hook and `commit`.
