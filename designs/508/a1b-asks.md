# A1b: a new card takes an agent’s need only as `nextNeed` would choose it

**Status:** the design for #508’s A1b (#711), rescoped after the integrator’s review of #781: the maintainer chose to shrink A1b to one tie rule and move the rest of A1 to A2. Citations are by file and function, read at `main` `23f09f80`; the code PR re-reads each one at its head. Its code is not built yet.

**What A1b is now.** #633 already derives an agent’s need from its cards (`nextNeed`, `server/card-needs.mjs`). Of the places that choose between two of an agent’s cards, two already agree, and the third, `offerNeed`, doesn’t: it lets any card of the same rank take the need, older or newer. A1b makes `offerNeed` choose as `nextNeed` would, and gives `needsOrder` a last tiebreak that doesn’t depend on the runtime’s locale. `card.held` stays as it is, and everything else in A1’s row of `design.md`’s rollout moves to A2 by name (§6).

**Requirements served:** AT-4 in part: every place that sets an agent’s need picks the card `nextNeed` would. The rest of AT-4, needs-you with a room’s items not loaded, moves to A2. AT-1 and DL-1 stay as on `main`: nothing held moves or is dropped.

## 1. Decisions

| # | Decision | Decided by |
|---|---|---|
| R1 | Keep `card.held` as it is until A2, so a downgrade loses no held wake. | the integrator’s review of #781, which offered it; ruled in review |
| R2 | Shrink A1b to the tie rule, and move the rest of A1 to A2. | the maintainer |
| R3 | No `asksOf`: the page’s `openAsks` is out of a server function’s reach without new published state, so nothing would read it. | review |
| R4 | No item-id tiebreak: ties go to the challenger, as `comesFirst` and `keptOrNext` already decide them, and ids are random. | review, on the code |
| R5 | One comparison, `challengerWins`, decides rank-then-time for `comesFirst`, `keptOrNext` and `offerNeed`, and `offerNeed` uses it (§3). | review |
| R6 | `needsOrder` breaks its last tie by code unit, not `localeCompare`. | review |
| R7 | The rule that review holds every route to public data moves its trigger from A1b to A2’s first private data. | review, read as a security change |

## 2. Today

- **`comesFirst`** (inside `nextNeed`): the lower `RANK` wins; on equal rank the card with the larger `at`, and on equal `at` the card read later (`at >= best.at`). `threadsOf` reads the agent’s own thread first, then its side threads, each in item order. So on equal `at` the later card within a thread wins, and across threads a side thread’s card wins. It’s deterministic.
- **`keptOrNext`** (`server/restart-sweep.mjs`, used by the restart sweep and by a Retry’s reset through `settledNeed`): the same card is kept; otherwise the lower `RANK`, then the larger `at`, and on equal `at` it takes `next`, `nextNeed`’s own result. When `nextNeed` counts the current need, that’s the same choice `comesFirst` makes; when it doesn’t (a kept block from an older turn, or a host’s permission not yet waited on after a restart), `keptOrNext` takes `next` on a tie, whatever the read order.
- **`offerNeed`** (`server/card-needs.mjs`): a card takes the need when none is set, or when its `RANK` is the same or lower, without reading either card. So a same-rank card always takes it, even an older one. Its callers:
  - a new permission card (`permission-cards.mjs`), a new hop card (`wake-cards.mjs`), and the first event of an app card (`apps.mjs`, `needAppSend`): each a new card;
  - `needAppSend` again for the card that already is the need, to update its “wants to send N messages” text;
  - `waitOn` (`remote/turns-prompts.mjs`), which offers again a permission card shown before a restart. Usually that card already is the need; it can be an older card than a newer current need.
- **`needAppSend`’s need carries no `threadId`,** unlike every other caller’s and `needOf`’s (`rt.awayFrom`). For an app card in a side thread, a lookup by the need’s thread finds nothing.
- **`needsOrder`** (`shared/needs.mjs`) orders the agents that need you, for Ctrl+J: the given conversation’s first, then the longest wait (`waitedSince`), then the session id by `localeCompare`, whose order depends on the runtime’s locale. The page (`needs-nav.mjs`) and the server’s room checks run it in different runtimes.

## 3. The design

- **`challengerWins(challenger, incumbent)`** in `server/card-needs.mjs`, exported: the lower `RANK` wins; on equal rank, the challenger wins unless its `at` is smaller. `comesFirst` (the challenger is the card being read), `keptOrNext` (the challenger is `next`) and `offerNeed` (the challenger is the offered card) all call it, so one decision is made in one place, and each keeps today’s tie direction: the challenger wins a tie.
- **`offerNeed(rt, se, need, state)`** takes the need when none is set, when it’s the same card as the current need (so `needAppSend`’s refresh keeps working), or when `challengerWins` says so. The two `at`s are read from pending, by each need’s thread and item, as `keptOrNext` reads them. When either card isn’t found there, `offerNeed` decides by rank alone, as today. A current need of a kind `RANK` doesn’t list is still never replaced.
- **`needAppSend`** gains `rt.awayFrom(se, app.threadId)`, as every other caller has, so its need names its thread.
- **`needsOrder`** breaks its last tie with code-unit comparison of session ids, written as an `if` chain.

**What changes:** one case. A same-rank card that is older than the current need no longer takes it. Of today’s callers only `waitOn` can offer one: after a restart, an older permission card no longer takes the need from a newer one. `offerNeed` still doesn’t check whether the current need’s card waits; that stays the resolvers’ and the sweeps’ job, as on `main`.

**Cost:** an offer reads two cards from pending, as `keptOrNext` already does: O(items in the two cards’ threads), once per new card. A per-thread item index (#712b, PR #769, not merged) would make it O(1).

## 4. Invariants and the failure table

- **I1. One comparison:** `comesFirst`, `keptOrNext` and `offerNeed` order any two cards they can both read the same way, through `challengerWins`; the offered card takes the need only if `challengerWins` ranks it first, or it is the same card.
- **I2. Ties go to the challenger,** never by id.
- **I3. Nothing held moves:** `card.held` is written and read as on `main`.
- **I4. Locale-free:** no reader of needs orders by `localeCompare`.

| Case | Today | After | On disk | A concurrent reader | The person |
|---|---|---|---|---|---|
| A new card of the same rank | takes the need | takes it (it isn’t older) | nothing new stored | sees the new need | the ring moves to it |
| The same card offered again | takes it, with its new text | the same | nothing new | sees the new text | the count updates |
| An older same-rank card offered after a restart (`waitOn`) | takes the need from a newer one | doesn’t | nothing new | sees the newer need kept | the newer card stays shown |
| A side-thread app card offered | its need has no thread | its need names its thread | nothing new | — | — |
| Either card not in pending | — | decided by rank alone, as today | nothing new | — | — |
| Two cards of one rank at the same `at`, in two threads | `nextNeed` keeps the side thread’s; `offerNeed` takes the offered one | the same: the challenger wins a tie | nothing new | — | — |
| Restart or Retry | `keptOrNext` may keep a need `nextNeed` doesn’t count, as #633 meant | the same | nothing new | — | as before |
| Upgrade or downgrade | — | nothing to convert or read back: A1b stores nothing new | — | — | as on `main` |

## 5. Tests, failing first

- **The `waitOn` spec:** a newer permission card is the need, and an older one is offered again after a restart; the newer one stays. It fails on `main`.
- **The side-thread app spec:** an app card in a side thread is offered against a same-rank hop that is older; the app card takes the need, and its need names its thread. It fails on `main`’s missing thread.
- **The `needAppSend` spec:** the card that is the need is offered again with a new count; its text updates. It passes on `main` and guards the same-card rule.
- **The permission-stays spec:** a permission is the need, and a hop is offered; the permission stays.
- **The one-comparison spec:** pairs of cards fed to `nextNeed`, `keptOrNext` (through `settledNeed`, since it isn’t exported) and `offerNeed`, in both orders, with fixed `at`s, including equal ones in one thread; all three agree. A mutant that adds an id tiebreak fails it.
- **The locale spec:** two session ids that differ only in case (`se_B`, `se_a`); `needsOrder` orders them by code unit.
- **Mutants:** dropping the same-card rule fails the `needAppSend` spec; dropping the age check fails the `waitOn` spec; dropping `awayFrom` fails the side-thread spec.

## 6. What moves to A2

From A1’s row of `design.md`’s rollout, by name: ask records; `card.held` becoming deliveries with `heldBy`, keeping `HELD_WAKES`, and #594’s case, which needs an owner on each hold; the Add card as an ask that holds (AT-7); derived open asks, and needs-you counts with a room’s items not loaded; #439’s and #326’s cases; INV-10; the `ask-dropped` and `needs-mismatch` checks; B3’s need for A1 to take `waitedSince` and `openAsks` off items; and the first private data and the check that holds it (“Carried to A2”).

`openAsks` (`app/js/open-asks.mjs`), the page’s list of asking blocks left open from earlier turns (#69), runs in the page over loaded items, and A1b leaves it as it is.

## 7. What’s unverified

- Whether any of #633’s specs pin `offerNeed` taking an older same-rank card: swept in the code PR.
- Agents other than Claude Code: the change is in the server and the page’s shared code, the same for every backend.

## 8. UAT

None for this note: it’s docs only. The code PR runs the needsnav scenario’s triggers, and `delivery.md` phase 1 (`held-behind-card`, `held-released`) to show held wakes behave as on `main`.

## Carried to A2: the case for keeping the first private records outside `state`

The review of this note’s earlier drafts worked out how A2’s first private records could be kept. Where they go is A2’s to decide (`design.md`, “What is state, what is in the store, and what reaches the browser”, still has records in `store.state`); this is the review’s case, for A2’s note to take up or answer, checking every new name against `main` first.

**A private store.** Records would live outside `state`, in a store field of their own, `store.privateRecords`, never in `rt.s`, so no reader of `rt.s` or `store.state` could see one, including whole-object copies such as the UAT facts’ `{ ...rt.s, items }` (`liveFacts`, `server/telemetry-report.mjs`). (`store.held` is taken: it’s the count of held emits that `server/store-held.mjs` gates every pending read on.) A `lint-security` rule would fail on a read of `privateRecords` outside an allowlist.

**Every channel off the laptop,** each with its reason no record leaks: `/api/state` and the stream; every other route, including write routes’ return values; the host snapshot; the host’s offline answers; telemetry reports and their `gh` issue, whose state today is `{ ...rt.s, items }`, not `publicState`; the apps’ query route; prompts and catch-ups; the agent’s own read tools, keyed on the session its turn token resolves to; error and status text (#632’s contract); and the store on disk.

**A canary test** would seed a private record for two agents, each holding a canary, and fail if one appears in any channel. It enumerates a declared route table, which a move-only first commit extracts from `server/index.mjs`. It must fail first with a record written into `state`, with `appQuery` reading private records, with the read tools returning every agent’s, and with records written into `snapshot.json`.

**The snapshot.** `snapshot.json` keeps its shape. Private records get their own file, `private-<seq>.json`, `{ seq, snapshotHash, records }`, with a hash of the snapshot’s text, so a stray file of the same length left by an older build’s `--fresh` isn’t accepted.
1. The state’s text and the records’ text are serialized in one synchronous section, at the same seq, so the log never replays records onto a file that already holds them.
2. The records’ file is written and fsynced before `snapshot.json` is renamed into place; that rename stays the one point where a save takes effect.
3. A records file counts only if its seq and hash match the loaded snapshot; any other is ignored, and removed only after the next snapshot is committed.
4. A test kills the process between the two writes, in both orders; the loaded state is consistent, and a mutant that prunes the old file too early fails it.
5. The file is mode 0600, stays on the laptop, and the canary test covers it.

**A downgrade:** a build without A2 reads `snapshot.json` as its own, never lists `private-*.json`, and replays the log’s record events as rejected (`replayEvent`, `server/store-replay.mjs`). What that loses depends on what A2 puts in records; A2’s note says so plainly and settles the `BREAKING CHANGE` rule first.

**#608’s limits on records:** the open and reserve size limits agree; `revise` can’t change `askKind` or `deliveryId`; `release` and `block` can’t change `mode` or `notBefore`; a closed id can’t be opened again; a dangling `deliveryId` and unknown part fields are refused; the reducer copies only the records a command touches.

**`delivery-routes.md`’s “A1b’s design reconciles them”** is answered here: A1b adds no records, and where A2’s go is A2’s note’s.
