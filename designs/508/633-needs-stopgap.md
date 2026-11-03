# #633: which card an agent needs you for, until A1b

**Status:** draft for #633’s head after `e776d4b0`, for lead-delivery’s peer read and critic’s verdict (RR 13). A stopgap: A1b derives needs from open ask records and replaces `nextNeed` (`design.md:607`; `execution-plan.md:41`). #508 actions 4 and 9 ask every stopgap note for a restart matrix and `main`’s behavior as a table; both are below.

## The rule

An agent needs you until its last waiting card is answered (#366). One slot, `se.needs`, still holds the card the page shows; `server/card-needs.mjs` decides what goes in it, and every setter and clear goes through it (`offerNeed`, `releaseNeed`, `nextNeed`).

Two kinds of cards:

- **Cards that wait until answered:** an app card’s messages (`appsend`), a wake or add request (`hop`), a permission while its tool call waits (`permissionWaits`). They count whatever turn made them.
- **Cards tied to a turn:** an asking block, a refusal (`denial`), a tool request (`toolask`), a failed reply. They count only while you haven’t moved past their turn (#69). Moving on means you, not another agent, started a turn (`turn.movesOn`, `runtime.mjs`).

Which comes first: `RANK` (permission, failed, block, refusal, tool request, then app cards and wake requests), and within a rank the newest. The turn’s end, a release and the restart sweep all choose the same way.

## Invariants

- **I1. One decider.** Every write to `se.needs` goes through `offerNeed` (a new card), `releaseNeed` (its card answered or retired) or `nextNeed` (the turn’s end, the restart sweep). A failed turn sets its need directly, as the turn’s end does, ranked behind only a permission.
- **I2. A clear is its own.** A resolver clears the need only when the need is its card (`releaseNeed`’s `itemId` check).
- **I3. A turn that doesn’t move on changes nothing about which cards count.** Its start records `keptTurnIds`: of the last turn and the turns kept before, those with a turn-tied card still open (`keptTurns`). They count mid-turn, at its end and after a restart, until you move on, which clears the list. This head adds I3; `e776d4b0` kept only a block (`keptId`), so the turn before’s refusals stopped counting under a wake (critic’s finding).
- **I4. The state survives a restart.** `lastTurnId`, `keptId` and `keptTurnIds` are on the session, in the store, and land in the snapshot. Nothing in memory decides a need.
- **I5. A need is kept only while its card waits.** After a restart, a laptop permission is no longer waiting (its tool call is gone), so it’s never kept; a host’s is, while the host keeps the prompt (`remote.keepsCard`).

## Cost

- `nextNeed` and `keptTurns`: one pass over the items of the agent’s conversation and its side and topic threads, O(items there). `turnsOf` answers a list of at most the turns still asking (I3), so `includes` costs O(turns still asking), in practice 0 to 2.
- They run when a card is answered, a turn ends or starts without moving on, and once per running session at a restart. Not per tool call or per message.
- A1b replaces the pass with a read of the agent’s open ask records.

## Restart matrix

The sweep (`server/restart-sweep.mjs`, `settleInterrupted`) runs at startup before the laptop’s permission cards expire (`server/index.mjs`, `settleInterrupted` then `expireStalePermissions`). It visits sessions that were running, and any whose need is a permission.

**S** = a spec in `tests/card-needs*.test.mjs` asserts it on this head. **R** = read from the code, not run.

| Need when the server stopped | Turn cut off | `main` after the restart | This head | Source |
|---|---|---|---|---|
| Block from the last turn | one you started | that block | the interrupted turn’s own block if it asked one, else none (you moved past it) | S: “after a restart, a block the interrupted turn showed is the need”; “…denying its app card doesn’t bring back the block” |
| Block the turn kept (a wake) | a wake | that block | that block, even if a permission took the need mid-turn | S: “after a restart cuts off a turn that didn’t move on…” (both) |
| Refusal, tool request or failed reply from the turn before | a wake | that need | that need; a failed one keeps its Retry state | S: “a restart during a turn that didn’t move on keeps a … need” (3 kinds) |
| Two refusals from the turn before, need on one | a wake | answering it moves the need to the other | the same | S: “critic’s probe…” (fails on `e776d4b0`) |
| Refusals from an earlier wake, under a second wake | a wake | answering one moves the need to the other | the same | S: “two wakes in a row…” (fails on `e776d4b0`) |
| Laptop permission | any | **stays the need on an expired card** (#721’s first gap) | none, or the next card that waits | S: “#721’s first gap…”; `main` by probe, see below |
| Host permission, host keeps the prompt | any | that permission | that permission | S: “a restart keeps a host turn’s permission…” |
| App card or wake request | any | that card | that card, unless a card that ranks ahead now waits | S: “…ranks ahead of a wake request that was the need” |
| Two cards of one rank both waiting | any | the current one | the newer one (the tie rule) | S: “on a tie, the newer card takes the need…” (fails on `e776d4b0`) |
| A block answered, or a card gone, before the stop | any | that need, stale | dropped | S: “a block you answered before the restart…”; “a need whose card is gone…” |
| No turn running, need not a permission | — | unchanged | unchanged (the sweep skips it) | R: the sweep’s `continue` |

**`main`’s laptop-permission row, probed at `48f20ccd`:** a script against the checkout opens a permission card with the need on it, then runs `main`’s startup reset (`server/index.mjs:136–138`) and `expireStalePermissions` (`:144`). It printed `card expired | needs {"kind":"permission",…} | state needs`, exit 0.

## Other paths, and how they differ from `main`

| Path | `main` | This head | Source |
|---|---|---|---|
| A newer card while an app card is the need | replaces it; answering the newer clears both (#366 case 1) | waits behind or takes it by rank; answering it falls back to the app card | S: “#366 case 1…” (4 specs) |
| A second app card | never the need, never notified (#366 case 2) | the need at once, notified once; answering it falls back to the first | S: “#366 case 2…” |
| Answering a card that isn’t the need | some resolvers cleared the need anyway (wake request, retire, Retry) | the need stays | S: “the integrator’s item…” (3 specs) |
| A permission released mid-turn | no need | no need; a wake’s kept turns still count | S: “a permission released during a running turn…”; “mid-turn: answering one refusal…” |
| Moving on | clears needs tied to a turn and a wake request | clears needs tied to a turn and the kept turns; a wake request waits until answered | S: “moving on keeps an open wake request…”; “moving on still clears…” |
| Retry | clears the need | falls back to cards that wait until answered only; the retried turn’s end decides the rest | S: “Retry clears the failure…”; “Retry doesn’t flash a block…” |
| A permission expiring at the turn’s end | flashes the block before | expires before the turn leaves the running turns, so no flash | S: “a permission that expires at the turn’s end…” |

## Retry and reload

- **Retry** is the one release that passes no turn (`releaseNeed(…, { turnIds: [] })`), because the retried turn starts at once and its end decides its cards.
- **A page reload** reads `se.needs` from the state; nothing here is in the page.

## Not covered

- **A host card nobody waits on during a running turn** (`endCard`’s `'tool'` state, `server/remote/turns-prompts.mjs`): no rig drives it. Unchanged from `e776d4b0`.
- **`keptId` and `keptTurnIds` overlap:** a kept block is a turn-tied card of a kept turn, so `keptTurnIds` could absorb `keptId`. Left as is to keep this head small; A1b removes both.
- **Backends:** the decider runs on the server, the same for every backend. UAT runs on Claude Code only (Q6); a host’s permission path is covered by specs, not by UAT.

## UAT

Trigger `app-need-fallback`: a session’s need goes from an app card to a newer need of another kind and back to the same app card. Reached by `tests/uat/e2e/scenarios/needsnav.md` phase 3, in which an agent’s app card waits, the agent asks a newer question, and you answer it. Its unit test fires on a recorded-shape room where the need falls back and stays silent on two where it doesn’t. It is still to be checked on a recorded needsnav run before the paid run; none was on this host when this was written.
