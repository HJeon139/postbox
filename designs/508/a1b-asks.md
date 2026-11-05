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
| R4 | No item-id tiebreak in `comesFirst` or `keptOrNext`: arrival order already decides their ties, deterministically, and ids are random. | review, on the code |
| R5 | `offerNeed` chooses as `nextNeed` would (§3). | review |
| R6 | `needsOrder` breaks its last tie by code unit, not `localeCompare`. | review |
| R7 | The rule that review holds every route to public data moves its trigger from A1b to A2’s first private data. | review, read as a security change |

## 2. Today

- **`comesFirst`** (inside `nextNeed`): the lower `RANK` wins; on equal rank the card with the larger `at` wins, and on equal `at` the card read later (`at >= best.at`). The read order is fixed: `threadsOf` lists the agent’s own thread and then its side threads, each with its items in order. So on a tie the later arrival wins, the same way every time.
- **`keptOrNext`** (`server/restart-sweep.mjs`, used by the restart sweep and by a Retry’s reset through `settledNeed`): the same card is kept; otherwise the lower `RANK`, then the larger `at`, and on equal `at` it takes `next`, which is `nextNeed`’s own result. It already agrees with `comesFirst`.
- **`offerNeed`** (`server/card-needs.mjs`): a card takes the need when none is set, or when its `RANK` is the same or lower. So a same-rank card always takes it, even an older one. Its callers:
  - a new permission card (`permission-cards.mjs`), a new hop card (`wake-cards.mjs`), and the first event of an app card (`apps.mjs`, `needAppSend`): each a new card, so newer;
  - `needAppSend` again for the card that already is the need, to update its “wants to send N messages” text;
  - `waitOn` (`remote/turns-prompts.mjs`), which offers again a permission card shown before a restart, which can be older than the current need.
- **`needsOrder`** (`shared/needs.mjs`) orders the agents that need you, for Ctrl+J: the given conversation’s first, then the longest wait (`waitedSince`), then the session id by `localeCompare`, whose order depends on the runtime’s locale. The page and the server’s room checks run it in different runtimes.

## 3. The design

`offerNeed(rt, se, need, state)` takes the need when:
1. none is set, or the current need’s card no longer waits (as `keptOrNext` reads it, from pending);
2. or it’s the same card as the current need: it always takes it again, so `needAppSend`’s refresh keeps working;
3. or its `RANK` is lower;
4. or its `RANK` is the same and its card isn’t older than the current need’s card, by `at` read from pending, the same comparison `keptOrNext` makes. On equal `at` the offered card takes it, as the later arrival.

A current need of a kind `RANK` doesn’t list is still never replaced, as today.

**What changes:** only rule 4. A same-rank card that is older than the current need no longer takes it. Of today’s callers, only `waitOn` can offer one: after a restart, an older permission card no longer takes the need from a newer one, which is what `nextNeed` would choose.

`needsOrder` breaks its last tie with code-unit comparison of session ids, written as an `if` chain.

**Cost:** rule 4 reads two cards from pending, as `keptOrNext` already does: O(items in the two cards’ threads), once per offer, which happens once per new card. A per-thread item index (#712b, PR #769, not merged) would make it O(1).

## 4. Invariants and the failure table

- **I1. One choice:** after any offer, the need is the card `nextNeed` would choose between the current need and the offered card.
- **I2. Arrival order decides ties:** two cards of one rank and one `at` order by arrival, in `comesFirst`, `keptOrNext` and `offerNeed` alike, never by id.
- **I3. Nothing held moves:** `card.held` is written and read as on `main`.
- **I4. Locale-free:** no reader of needs orders by `localeCompare`.

| Case | Today | After | A concurrent reader | The person |
|---|---|---|---|---|
| A new card of the same rank | takes the need | takes it (it’s newer) | sees the new need | the ring moves to it |
| The same card offered again | takes it, with its new text | the same | sees the new text | the count updates |
| An older same-rank card offered after a restart (`waitOn`) | takes the need from a newer one | doesn’t | sees the newer need kept | the newer card stays the one shown |
| Two cards of one rank in the same millisecond | the later arrival wins | the same, pinned by a test | — | — |
| Restart or Retry | `keptOrNext` may keep a need `nextNeed` doesn’t count, as #633 meant | the same | — | as before |
| Upgrade to A1b | — | nothing to convert: A1b stores nothing new | — | — |
| Downgrade from A1b | — | nothing to read back | — | as on `main` |

## 5. Tests, failing first

- **The `waitOn` spec:** a newer permission card is the need, and an older one is offered again after a restart; the newer one stays. It fails on `main`.
- **The `needAppSend` spec:** the card that is the need is offered again with a new count; its text updates. It passes on `main` and guards rule 2.
- **The arrival-order spec:** two cards of one rank at the same `at`, fed to `nextNeed`, `keptOrNext` (through `settledNeed`, since it isn’t exported) and `offerNeed`; all three pick the later arrival. A mutant that adds an id tiebreak fails it.
- **The locale spec:** two session ids that differ only in case (`se_B`, `se_a`), which `localeCompare` and code-unit order sort differently; `needsOrder` orders them by code unit.
- **Mutants:** dropping rule 2 fails the `needAppSend` spec; dropping rule 4’s age check fails the `waitOn` spec.

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
