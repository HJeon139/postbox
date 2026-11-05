# A1b: every open ask, derived from the cards, in one order

**Status:** the design for #508’s A1b (#711), revised after the integrator’s review of #781. Citations are by file and function, read at `main` `23f09f80`; the code PRs re-read each one at their own head. Its code is not built yet.

**What changed after the integrator’s review:** A1b keeps `card.held` as it is. The hold record, the private store outside `state`, its snapshot file and the sweep of every channel off the laptop move to A2, which adds the first records anyway (“Carried to A2” below). So a downgrade loses nothing: no held wake moves anywhere a `main` build can’t read (AT-1, DL-1). `asksOf` now reads exactly what `nextNeed` reads, since a derive over published `state` couldn’t match it.

**Requirements served:** AT-4, “needs you” correct and complete in every conversation, through one function that lists every open ask in one order. AT-1 and DL-1 are kept as they are on `main`: nothing held is moved or dropped. AT-2 is unchanged.

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Asks are derived, not stored.** `asksOf(rt, se)` in `server/card-needs.mjs` returns every open ask of a session in order, and `nextNeed` becomes `asksOf(rt, se)[0]`. No record holds an ask. | The integrator’s smaller structural fix on #608. #633’s `nextNeed` already derives the need from the cards; A1b widens it from the first ask to all of them, so every reader of “needs you” and the open-asks list reads one function. |
| D2 | **`asksOf` takes `nextNeed`’s own inputs:** the session’s threads’ pending items (`rt.store.pending.items`), the runtime’s permission waits and turns, the turns that count (`turnsOf`) and a running keep (`runningKeep`), each ask made by `needOf`, ranked by `RANK`. | A derive over published `state` can’t equal `nextNeed`: it misses held emits, permission waits and which turns still count. One loop, one set of inputs. |
| D3 | **`card.held` stays as it is until A2.** A1b adds no record, no private key and no new state. | A hold record would be lost on a downgrade, since an older build can’t read it (the integrator’s third point). A2 owns deliveries and adds records first, so the hold moves with it. |
| D4 | **Ties use code-unit order** (`a.id < b.id`), in `comesFirst` and in `needsOrder` (`shared/needs.mjs`), whose `localeCompare` changes in the same PR. | #608’s finding: `localeCompare` depends on the locale. One PR changes the order once, with its equivalence spec. |
| D5 | **The first producer is the asking card** that `nextNeed` already ranks: a block or an app-send card that waits on the person. | #366’s case, and the equivalence spec has one target. |

## 2. What exists today

- **`nextNeed(rt, se, o)`** (`server/card-needs.mjs`) loops over the session’s threads (`threadsOf`) and their pending items, makes a need from each card (`needOf`), and keeps the best by `comesFirst`. It counts refusals, so several are reported as one. `offerNeed` and `releaseNeed` are its setter and clear, and `keptTurns` records the turns still asking at the start of a turn that doesn’t move on.
- **`needsOrder`** (`shared/needs.mjs`) orders the sessions that need the person, by `waitedSince`, with `localeCompare` breaking ties.
- **`card.held`** is a list on a card item of the wakes it holds. It’s public state, read by the page and by an older build alike.

## 3. The design

- **`asksOf(rt, se, o)`** is `nextNeed`’s loop, keeping every need instead of the best: it returns them sorted by `comesFirst`, with the refusal count applied to the first denial as today. `nextNeed(rt, se, o)` becomes `asksOf(rt, se, o)[0] ?? null`.
- **Readers:** “needs you” keeps reading `se.needs`, which `offerNeed` and `releaseNeed` still set from `nextNeed`; the open-asks list reads `asksOf`. A1b changes what they read, not who writes.
- **Cost:** `asksOf` does the same pass `nextNeed` does: O(items in the session’s threads) per call, plus a sort of the asks found, which are few. It adds no scan. No index serves it today: `#769`’s index maps an item’s id to its place, and `asksOf` scans by session and kind. A per-session index of open cards would be a separate design, measured first.

## 4. Invariants and the failure table

- **I1. One function:** every reader of a session’s open asks reads `asksOf`, and `nextNeed` is its first entry.
- **I2. A clear is its own** (#633’s): only the card’s resolver clears its need.
- **I3. Code-unit order** on every reader, `needsOrder` included.
- **I4. Nothing held moves:** `card.held` is written and read as on `main`.

| Step | After a kill | The person |
|---|---|---|
| A card is written, its need not yet set | the card, no need | `asksOf` already lists it; the ring follows on the next derive |
| Restart | asks derived again from the cards; #633’s sweep sets `se.needs` | as before |
| Store Retry after an outage | the reload rebuilds `state`, and asks are derived from it | the same cards |
| A downgrade to a build before A1b | nothing to read back: A1b stores nothing new | as on `main` |

## 5. Tests, failing first

- **The equivalence spec:** on every fixture, `asksOf(...)[0]` equals `nextNeed` as it is on `main`, except on ties, where code-unit order wins; `needsOrder` is held to the same order.
- **#366’s two cases,** failing on `main`.
- **The tie spec:** two asks at the same `at` in a locale where `localeCompare` and code-unit order differ.
- **One `asksOf` call,** timed on the 10× generated room, beside one `nextNeed` call on `main`.

## 6. What’s unverified

- **#594’s case** (a held wake blocks an unrelated message) needs an owner on each hold, so it moves to A2 with the hold record. A1b doesn’t fix it.
- **The open-asks list’s readers:** which views read it today beyond “needs you” is to be swept in the code PR, at its head.
- **Agents other than Claude Code:** UAT runs Claude Code only; the change is in the server, the same for every backend.

## 7. UAT

None for this note: it’s docs only. The code PR runs the needsnav scenario’s triggers, and `delivery.md` phase 1 (`held-behind-card`, `held-released`) to show held wakes behave as on `main`.

## 8. Files

- **The code PR:** `server/card-needs.mjs` (`asksOf`, `nextNeed`), `shared/needs.mjs` (`needsOrder`’s ties), the open-asks list’s readers, and their tests.
- **This note:** `designs/508/a1b-asks.md`, a row in `designs/508/README.md`, and pointers from `design.md`’s A1 lines: “6. Data model”, the `se.needs` mapping in “6.2 Records”, and the conversion in “13. Migration, compatibility and rollback”.

## Carried to A2: the first private records

The review of this note’s earlier drafts settled how the first private records should be kept. A2 adds them, so this is A2’s to build; it’s kept here so the findings aren’t lost, and A2’s note takes it over.

**The private store.** Records live outside `state`, in a store field of their own, `store.privateRecords`, never in `rt.s`, so none of the server’s readers of `rt.s` or `store.state` can see one, including whole-object copies such as the UAT facts’ `{ ...rt.s, items }` in `server/telemetry-report.mjs` (`liveFacts`). (`store.held` is taken: it’s the count of held emits that `server/store-held.mjs` gates every pending read on.) A `lint-security` rule fails on a read of `privateRecords` outside an allowlist: the records module, the reducer’s case for records, the snapshot writer and loader, Retry’s reload, and the agent’s own read tools.

**Every channel off the laptop,** each with its reason no record leaks: `/api/state` and the stream; every other route, including write routes’ return values; the host snapshot (built from `rt.s`, so it carries no records); the host’s offline answers; telemetry reports and their `gh` issue; the apps’ query route; prompts and catch-ups; the agent’s own read tools, keyed on the session the call’s turn token resolves to; error and status text (#632’s contract); and the store on disk. The telemetry report today builds its state from `{ ...rt.s, items }`, not from `publicState`; A2 keeps that safe only because `rt.s` holds no record, and adds a test of it.

**The canary test** seeds a private record for two agents, each holding a canary, and fails if a canary appears in any channel above. It enumerates a declared route table, which a move-only first commit extracts from `server/index.mjs`. It must fail first with one record written into `state`, with `appQuery` reading private records, with the read tools returning every agent’s records, and with records written into `snapshot.json`.

**The snapshot.** `snapshot.json` keeps its shape: the state itself. Private records get their own file, `private-<seq>.json`, `{ seq, snapshotHash, records }`, where `snapshotHash` is a hash of the snapshot’s text, the same O(n) as its length but not matched by a stray file an older build’s `--fresh` leaves behind.
1. The state’s text and the records’ text are serialized in one synchronous section, at the same seq, so the log never replays records onto a file that already holds them.
2. The records’ file is written and fsynced before `snapshot.json` is renamed into place. The snapshot’s rename stays the one point where a save takes effect.
3. A records file counts only if its seq and hash match the loaded snapshot. Any other is ignored, and removed only after the next snapshot is committed.
4. A test kills the process between the two writes, in both orders, and the loaded state is consistent. A mutant that prunes the old records file too early fails it.
5. The file is mode 0600, stays on the laptop, and the canary test covers it.

**A downgrade:** a `main` build reads `snapshot.json` as its own, never lists `private-*.json`, and replays the log’s record events as rejected (`server/store-replay.mjs`, `replayEvent`). What that loses depends on what A2 puts in records; A2’s note says so plainly, and settles the `BREAKING CHANGE` rule, before any record holds something a person would miss.

**#608’s limits on records:** the open and reserve size limits agree; `revise` can’t change `askKind` or `deliveryId`; `release` and `block` can’t change `mode` or `notBefore`; a closed id can’t be opened again; a dangling `deliveryId` and unknown part fields are refused; the reducer copies only the records a command touches, never the whole set.

**Where A2’s records go:** outside `state`, as above. `delivery-routes.md`’s “A1b’s design reconciles them” is answered here: A1b adds no records, and A2’s go in the private store.

**Older notes that speak of A1b’s records** (`601-held-view.md`, `609-reducer-throw.md`, `637-open-topic.md`) now mean A2’s: A1b adds none.
