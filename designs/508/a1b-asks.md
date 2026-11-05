# A1b: one rule for which card an agent needs you for, when two tie

**Status:** the design for #508’s A1b (#711), rescoped after the integrator’s review of #781. Citations are by file and function, read at `main` `23f09f80`; the code PR re-reads each one at its head. Its code is not built yet.

**What A1b is now.** #633 already derives an agent’s need from its cards (`nextNeed`, `server/card-needs.mjs`). The integrator’s review showed that a hold record would be lost on a downgrade, so `card.held` stays as it is until A2. With no record to add, A1b is one tie rule, shared by the three places that choose between two cards, plus a locale-free last tiebreak in `needsOrder`. Everything else in A1’s row of `design.md`’s rollout moves to A2 by name (§5).

**Requirements served:** AT-4, “needs you” correct and complete, in that every place that picks a card picks the same one. AT-1 and DL-1 stay as on `main`: nothing held moves or is dropped.

## 1. Today

Three places choose which of two cards an agent needs you for, and they decide an exact tie in different ways or not at all:
- **`comesFirst`** (`server/card-needs.mjs`), inside `nextNeed`: by `RANK`, then the newer card (`at >= best.at`), so on equal rank and time the card read later wins, which depends on the order the threads and items are read in.
- **`keptOrNext`** (`server/restart-sweep.mjs`), used by the restart sweep and by a Retry’s reset: by `RANK`, then `at` (`>=` again), comparing the kept need with the next one.
- **`offerNeed`** (`server/card-needs.mjs`): by `RANK` only; a new card of the same rank always takes the need.

Separately, **`needsOrder`** (`shared/needs.mjs`) orders the agents that need you across rooms, for Ctrl+J: nearest room first, then the longest wait, then the session id with `localeCompare`, whose order depends on the runtime’s locale. That isn’t a choice between cards, so it keeps its own order.

## 2. The design

- **`cardBefore(a, b)`** in `server/card-needs.mjs`, one function, used by `comesFirst`, `keptOrNext` and `offerNeed`:
  1. the lower `RANK` first;
  2. then the newer card (the larger `at`), as today;
  3. only on an exact tie of rank and time, the smaller item id in code-unit order (`a.id < b.id`).

  Item ids come from `newId`, which is random, so the id is an arbitrary but fixed tiebreak, never a stand-in for “older”.
- **`offerNeed`** asks `cardBefore(new, current)`; a same-rank newer card still takes the need, as `nextNeed` would choose it.
- **`needsOrder`** breaks its last tie with plain code-unit comparison of session ids (`a < b ? -1 : a > b ? 1 : 0`, written as an `if` chain), so the server’s room checks and the page order two agents the same way.
- **Cost:** none added: each place already compares two cards or two sessions; the rule is O(1) per comparison.

## 3. Invariants and the failure table

- **I1. One rule:** `comesFirst`, `keptOrNext` and `offerNeed` agree on every pair of cards, in either order.
- **I2. Nothing held moves:** `card.held` is written and read as on `main`.
- **I3. Locale-free:** no reader of needs orders by `localeCompare`.

| Case | Today | After |
|---|---|---|
| Two cards of one rank at the same `at` | the card read later wins in `nextNeed`; `keptOrNext` keeps the current one; `offerNeed` takes the new one | the smaller id, in all three |
| Restart or Retry | `keptOrNext` may keep a need `nextNeed` doesn’t count (a block from an older turn), as #633 meant | the same; ties between the two follow I1 |
| A downgrade to a build before A1b | — | nothing to read back: A1b stores nothing new |

## 4. Tests, failing first

- **The agreement spec:** the same pair of equal-rank, equal-time cards fed to `nextNeed`, `keptOrNext` and `offerNeed` in both orders; all three pick the same card. It fails on `main`. A mutant that drops the id tiebreak fails it.
- **The locale spec:** two session ids that `localeCompare` orders differently under a non-English collation; `needsOrder` orders them by code unit.
- **#633’s specs** pass unchanged, except where they pinned the read-order tie, which the PR names.

## 5. What moves to A2

From A1’s row of `design.md`’s rollout, by name:
- `card.held` becoming deliveries with `heldBy`, keeping `HELD_WAKES`, and #594’s case, which needs an owner on each hold;
- the Add card as an ask that holds (AT-7);
- needs-you counts with a room’s items not loaded;
- B3’s need for A1 to take `waitedSince` (`shared/needs.mjs`) and `openAsks` (`app/js/open-asks.mjs`) off items;
- the first private records and the check that holds them (“Carried to A2” below).

`openAsks`, the page’s list of asking blocks left open from earlier turns (#69), runs in the page over loaded items. A server function can’t serve it without new published state, so A1b leaves it as it is.

## 6. What’s unverified

- Which of #633’s specs pin today’s read-order tie: swept in the code PR.
- Agents other than Claude Code: the change is in the server and the page’s shared code, the same for every backend.

## 7. UAT

None for this note: it’s docs only. The code PR runs the needsnav scenario’s triggers, and `delivery.md` phase 1 (`held-behind-card`, `held-released`) to show held wakes behave as on `main`.

## Carried to A2: the first private records

The review of this note’s earlier drafts settled how the first private records should be kept. A2 adds them, so this is A2’s to build; A2’s note takes it over and checks every new name against `main` first.

**The private store.** Records live outside `state`, in a store field of their own, `store.privateRecords`, never in `rt.s`, so no reader of `rt.s` or `store.state` can see one, including whole-object copies such as the UAT facts’ `{ ...rt.s, items }` (`liveFacts`, `server/telemetry-report.mjs`). (`store.held` is taken: it’s the count of held emits that `server/store-held.mjs` gates every pending read on.) A `lint-security` rule fails on a read of `privateRecords` outside an allowlist. The rule in `AGENTS.md` and `designs/architecture.md`, that review holds every other route to public data until a check exists, then means this store and its lint.

**Every channel off the laptop,** each with its reason no record leaks: `/api/state` and the stream; every other route, including write routes’ return values; the host snapshot; the host’s offline answers; telemetry reports and their `gh` issue, whose state today is `{ ...rt.s, items }`, not `publicState`; the apps’ query route; prompts and catch-ups; the agent’s own read tools, keyed on the session its turn token resolves to; error and status text (#632’s contract); and the store on disk.

**The canary test** seeds a private record for two agents, each holding a canary, and fails if one appears in any channel. It enumerates a declared route table, which a move-only first commit extracts from `server/index.mjs`. It must fail first with a record written into `state`, with `appQuery` reading private records, with the read tools returning every agent’s, and with records written into `snapshot.json`.

**The snapshot.** `snapshot.json` keeps its shape. Private records get their own file, `private-<seq>.json`, `{ seq, snapshotHash, records }`, with a hash of the snapshot’s text, so a stray file of the same length left by an older build’s `--fresh` isn’t accepted.
1. The state’s text and the records’ text are serialized in one synchronous section, at the same seq, so the log never replays records onto a file that already holds them.
2. The records’ file is written and fsynced before `snapshot.json` is renamed into place; that rename stays the one point where a save takes effect.
3. A records file counts only if its seq and hash match the loaded snapshot; any other is ignored, and removed only after the next snapshot is committed.
4. A test kills the process between the two writes, in both orders; the loaded state is consistent, and a mutant that prunes the old file too early fails it.
5. The file is mode 0600, stays on the laptop, and the canary test covers it.

**A downgrade:** a build without A2 reads `snapshot.json` as its own, never lists `private-*.json`, and replays the log’s record events as rejected (`replayEvent`, `server/store-replay.mjs`). What that loses depends on what A2 puts in records; A2’s note says so plainly and settles the `BREAKING CHANGE` rule first.

**#608’s limits on records:** the open and reserve size limits agree; `revise` can’t change `askKind` or `deliveryId`; `release` and `block` can’t change `mode` or `notBefore`; a closed id can’t be opened again; a dangling `deliveryId` and unknown part fields are refused; the reducer copies only the records a command touches.

**Where A2’s records go:** outside `state`, as above, which answers `delivery-routes.md`’s “A1b’s design reconciles them”.
