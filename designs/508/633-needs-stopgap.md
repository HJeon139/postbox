# #633: which card an agent needs you for, until A1b

**Status:** revision 4: revision 3, which the person approved, plus the fixes from the pre-review packet’s independent read (S3 rule 4). critic’s re-read of the changes since revision 2 is still to come. A stopgap: A1b derives needs from open ask records and replaces `nextNeed` (`design.md:607`; `execution-plan.md:41`). #508 actions 4 and 9 ask every stopgap note for a restart matrix and `main`’s behavior as a table; both are below.

## Decisions

- **`keptTurnIds`, a list, where the person chose one `keptTurnId`** (`s3-groom-633-q`, Q-A). With one field, a second wake in a row drops the first wake’s own refusals; the spec “two wakes in a row…” pins that case. The list holds only turns still asking something (I3), so it stays short. This changes the person’s answer, so it goes to them in round 1’s decisions after critic’s verdict.
- **Ties go to the newer card everywhere,** the restart sweep included (Q-B).

## The rule

An agent needs you until its last waiting card is answered (#366). One slot, `se.needs`, still holds the card the page shows; `server/card-needs.mjs` decides what goes in it, and every setter and clear goes through it (`offerNeed`, `releaseNeed`, `nextNeed`).

Two kinds of cards:

- **Cards that wait until answered:** an app card’s messages (`appsend`), a wake or add request (`hop`), a permission while its tool call waits (`permissionWaits`). They count whatever turn made them.
- **Cards tied to a turn:** an asking block, a refusal (`denial`), a tool request (`toolask`), a failed reply (an agent item with status `failed`, whose Retry waits). They count only while you haven’t moved past their turn (#69). Moving on means you, not another agent, started a turn (`turn.movesOn`, `runtime.mjs`).

Which comes first: `RANK` (permission, failed, block, refusal, tool request, then app cards and wake requests), and within a rank the newest by the card’s time (`at`, which `addItem` always stamps). `nextNeed` (the turn’s end, a release) and `keptOrNext` (the restart sweep and a Retry’s reset, through `settledNeed`) choose the same way.

## Invariants

- **I1. One decider, and four direct writes.** Every write to `se.needs` goes through `offerNeed` (a new card), `releaseNeed` (its card answered or retired), `nextNeed` (the turn’s end), or `settledNeed` (`server/restart-sweep.mjs`: the restart sweep and a Retry’s reset), except four:
  - a laptop turn that fails sets `failed` (`server/runtime.mjs:1005`);
  - a host turn interrupted on its host sets `failed` (`server/remote/turns-resume.mjs:158`);
  - archiving an agent (`runtime.mjs:2607`) and retiring a fork (`server/side-threads.mjs:196`) clear it.

  The two `failed` writes end the turn, so they outrank whatever it waited on, a host permission it kept included: that permission belonged to the turn that just failed, and its prompt goes with it. That is `main`’s order too. R: read from the code; no rig drives a host interrupt with a kept permission card.
- **I2. A clear is its own.** A resolver clears the need only when the need is its card (`releaseNeed`’s `itemId` check).
- **I3. A turn that doesn’t move on changes nothing about which cards count.** Its start records `keptTurnIds`: of the last turn and the turns kept before, those with a turn-tied card still open (`keptTurns`). Their cards count mid-turn, at its end and after a restart, until you move on, which clears the list. So the list is bounded by the turns with an open turn-tied card, and shrinks as you answer them; a spec pins that a wake when nothing waits keeps none. A failed reply is a turn-tied card too, so a wake keeps its Retry, through a permission answered mid-wake and a restart. This head adds I3; `e776d4b0` kept only a block (`keptId`), so the turn before’s refusals stopped counting under a wake (critic’s finding).
- **I4. The state survives a restart.** `lastTurnId`, `keptId` and `keptTurnIds` are on the session, in the store, and land in the snapshot. What lives only in memory is what a restart ends anyway: the running turns (`rt.turns`) and the permission calls still waiting (`rt.permissionWaits`), which is why a laptop permission is never kept (I5). `lastTurnId` is set at a turn’s start, so it means the running or the last turn; its one other reader, `server/apps.mjs:51`, reads it only when no turn runs.
- **I5. A need is kept only while its card waits.** After a restart, a laptop permission is no longer waiting (its tool call is gone), so it’s never kept; a host’s is, while the host keeps the prompt (`remote.keepsCard`).

## Cost

- **`nextNeed` and `keptTurns`:** O(T + I), where T is every thread in the store and I the items of the agent’s conversation and its side and topic threads. `threadsOf` (`server/card-needs.mjs:11–16`) finds the child threads by walking every thread, since the store keeps no index of a thread’s children. `turnsOf` answers at most the turns still asking (I3), so `includes` adds O(turns still asking), in practice 0 to 2.
- **When:** a card answered, a turn’s end, a turn’s start that doesn’t move on, and once per running session at a restart or a Retry. Never per tool call or per message. `main`’s turn end also scans the turn’s thread’s items (`runtime.mjs`, `endTurn`), so the added cost over `main` is the thread walk and the child threads’ items.
- **Measured** (`nextNeed` alone, 200 runs after 20 warm-ups, on `tools/uat/big-room.mjs`’s generated room, node 24.21.0, this build host):

| Room | Threads in the store | p50 | p95 |
|---|---|---|---|
| 1× (1,001 items) | 1 | 0.077 ms | 0.175 ms |
| 10× (10,001 items) | 1 | 0.448 ms | 0.869 ms |
| 10× (10,001 items) | 2,001 | 0.933 ms | 1.449 ms |

  So 2,000 threads add about 0.5 ms, and 10× the items about 0.4 ms. Both stay well under a frame.
- **No index of a thread’s children on this head** (critic’s ruling): it would turn T into the agent’s own threads, but it would be a second structure kept in step with the store, for a function A1b replaces with a read of the agent’s open ask records. At 2,000 threads the walk costs about 0.5 ms per call (above), and the sweep makes one call per running session.

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
| Two cards of one rank both waiting | any | the current one | the newer one, by the cards’ times (the tie rule) | S: “on a tie, the newer card takes the need…” (fails on `e776d4b0`); “on a tie the sweep compares the cards’ times…” |
| A block answered, or a card gone, before the stop | any | that need, stale | dropped | S: “a block you answered before the restart…”; “a need whose card is gone…” |
| No turn running, need not a permission | — | unchanged | unchanged (the sweep skips it) | R: the sweep’s `continue` |
| **Store Retry** finds the agent mid-turn with no turn running (`store-outage.mjs`, `settleOrphanTurns`) | — | state set idle, need left as it was: an answered block stays the need, and a waiting app card shows with the ring idle | settled by the same rule as a restart (`restart-sweep.mjs`, `settledNeed`) | S: “a Store Retry that finds the agent mid-turn…” (fails with `main`’s reset in its place) |
| A card answered while the store is closed | the answer is refused with the store’s error; nothing changes | the same: in `resolveDenial`, `settlePermission` and `resolveHop` the card’s patch comes before the need’s, so a refused answer moves neither | R: those three resolvers |
| A host turn’s end | — | the same `nextNeed` call as a laptop turn: `endTurn` hands a remote turn to `server/remote/turns-end.mjs` and then chooses the need itself | R: `turns-end.mjs` header; `runtime.mjs`, `endTurn` |
| A host permission a release or a turn’s end meets after a restart, before the host asks again | — | not counted: `nextNeed` counts a permission only while its wait is registered, and the host re-registers it when it sends the prompt again (`server/remote/turns-prompts.mjs:42`, `waitOn`, which offers the need at `:65`) | R |
| A failed need under a wake that ends | **dropped, with its Retry** | kept while Retry waits, unless a card that ranks ahead waits; also after a permission answered mid-wake, and across a restart | S: “a wake’s end keeps a failed turn’s need…”; “the packet’s probe: a wake’s permission answered…” (both fail on `ca42ae8c`) |
| A block from an older turn that was the need, under a wake | that block | that block, kept by `keptId` alone (its turn isn’t a kept turn), through a permission and a restart | S: “a block from an older turn that was the need…” (both) |
| A card in a topic of another conversation | not the agent’s | not the agent’s: `threadsOf` takes only threads whose `parentId` is the agent’s conversation | S: “a card in a topic of another conversation…” |

**`main`’s laptop-permission row, probed at `48f20ccd`:** a script against the checkout opens a permission card with the need on it, then runs `main`’s startup reset (`server/index.mjs:136–138`) and `expireStalePermissions` (`:144`). It printed `card expired | needs {"kind":"permission",…} | state needs`, exit 0.

## Other paths, and how they differ from `main`

| Path | `main` | This head | Source |
|---|---|---|---|
| A newer card while an app card is the need | replaces it; answering the newer clears both (#366 case 1) | waits behind or takes it by rank; answering it falls back to the app card | S: “#366 case 1…” (4 specs) |
| A second app card | never the need, never notified (#366 case 2) | the need at once, notified once; answering it falls back to the first | S: “#366 case 2…” |
| Answering a card that isn’t the need | some resolvers cleared the need anyway (wake request, retire, Retry) | the need stays | S: “the integrator’s item…” (3 specs) |
| An agent withdraws its block, a stale wake card retires, an app retires, a host’s prompt ends with no wait | the need goes to none | falls back to the next card that waits | S: `tests/card-needs-callers.test.mjs`, one spec each, each failing with `main`’s clear in place |
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
- **Privacy of the run’s history:** a recorded room’s events now keep each session’s handle, and its need’s kind and card id (`server/room-events.mjs`, `keepEvent`), never the need’s text. These are public session fields, and #508 action 8’s scan reads the same file.
- **Size:** Biome counts `server/card-needs.mjs` at between 110 and 119 lines against its 300-line cap, and `server/room-events.mjs` under 50 against 300. No ceiling changed (`lint-caps` exit 0).
- **Backends:** the decider runs on the server, the same for every backend. UAT runs on Claude Code only (Q6); a host’s permission path is covered by specs, not by UAT.

## UAT

Trigger `app-need-fallback`: a session’s need goes from an app card to a newer need of another kind and back to the same app card. Reached by `tests/uat/e2e/scenarios/needsnav.md` phase 3, in which an agent’s app card waits, the agent asks a newer question, and you answer it. Its unit test fires on a recorded-shape room where the need falls back and stays silent on two where it doesn’t. No recorded needsnav run is on this host. On the recorded run lead-delivery pointed to (`uc04-evalgen-t09`, 5,688 events, 4,108 of them session events), the trigger reports `recorded: false` and fires 0 times: the run predates the field. So a fresh recorded run is the first real check, before the paid one.
