# B1: the view state first, positions later

| | |
|---|---|
| **Status** | Work in progress. Approved under rule 13: critic's read, gemini's peer read and the person's approval. B1b is partly built on `feat/508-b1b-view-state`; B1a waits with the server window |
| **Issue** | #531 (part of #508) |
| **Design** | `designs/508/design.md` §6.1, §10 “Browser”, §14 row B1 |
| **Done when** | the 13 scroll regressions (PF-3) as Playwright specs; `bigroom.md` phase 1, where `window-paged-back` fires and `view-moved` stays silent; later, the replay numbering test (B1a) |

## Why this order

The person chose client-side virtualization first, with the server window deferred. Virtualization needs the same explicit follow-and-anchor state, so B1b comes first. B1a, item positions, waits with the server window, since only paging and A1b's fold cursor need `n`.

## Where it stands

On `feat/508-b1b-view-state`, rebased onto `main` after #633 and #741 merged. B1b is now three slices (sprint 3): **B1b-a**, the view read, is this branch; B1b-b (the runner keeps the view, and the tester can scroll) and B1b-c (the probe, `view-moved`, `window-paged-back` and phase 1’s UAT) follow, designed in the B1b addendum.

| Commit | What it does |
|---|---|
| the move | The view logic moves out of `thread.mjs` into `app/js/view-state.mjs`, logic unchanged. `thread.mjs` drops from 1,812 to 1,635 lines; its ceiling is lowered after the merge (AGENTS.md, “Code size”) |
| #341’s spec | #341 part 2’s spec, made deterministic: a 1 px padding doesn’t change the transcript’s height, so the old guard never ran the race. With 40 px it fails every time |
| #341’s fix | A scroll the transcript hasn’t heard of yet isn’t taken back by a resize in the same frame: `follow()` moves the anchor by that scroll (`heard()`). A first version also skipped this when the scroll box changed size; no spec reached that check, #88’s resize cases included, so a later commit removes it |
| #357 and #356 | #357’s clamp fix (`a0b13bf5`) gets a spec that fails without it. #356’s spec names it: CI’s `late` pass runs the #88 panel case with the events late |
| the view read (B1b-a) | `data-view-mode`, `data-view-anchor` and `data-view-offset` on the transcript, main and panel, after each way in that can change them without a scroll event of its own; a redraw from new state takes an anchor that’s gone again. V1: `tests/browser/view-read.spec.mjs` |

**Still to do for B1b:**
- B1b-b and B1b-c, as above. B1b-a counts as done only when B1b-c’s phase 1 run passes (Q4);
- PF-3's list: replace #357, a merged PR, with the clamp fix it found (`a0b13bf5`);
- a UAT run of phase 1 before review.

## What `main` has

- **The view state is implicit:** `stuck`, `anchor { key, at }` and `unseen` inside `mountTranscript`'s closure. B1b's first commit moves them into `view-state.mjs`.
- **PF-3's 13 issues:** 11 have specs that cite them. #341 is open, with part 1 fixed in #579. #356 had no spec citing it, and #357 is a merged PR, not a bug.
- **`bigroom.md` phase 1's trigger and check don't exist** in `tools/uat/`.
- **No positions:** order is array order (`shared/state.mjs`).

## B1b, the view state

- **`app/js/view-state.mjs`:** `{ mode: 'following' } | { mode: 'reading', anchorId, offset }`, plus `unseen`. Only the person's input (wheel, keys, the jump pill, ⌃J, a link) changes the mode, and every DOM change re-applies it. It's the seam virtualization uses: a virtual list mounts and unmounts rows, and the view state re-anchors on each change, as for a growing reply.
- **The 13 regressions:** the 11 existing specs pass unchanged, normally and with the events late. #341 part 2, #356 and #357 are covered, as above.
- **`bigroom.md` phase 1:** the trigger `window-paged-back`, where the persona scrolls up through earlier days, and the check `view-moved`, where the page's probe compares the anchor's offset before and after each change. gemini runs the phase. From gemini's peer read: a 1 px threshold, sampling only when settled, a following-mode bottom gap of 2 px at most, and the probe recording `{ anchorId, expectedOffset, actualOffset, delta, cause }`.

## B1a, positions (later, with the server window)

**Invariants**
- **INV-5:** an item's `n` never changes, except that a move gives it a new, larger `n`. In each thread the list is sorted by `n`, and an `n` is never given twice.
- **INV-6, new:** an item leaves a list only with its thread. Today the only removal is `remove` of a whole thread, and every move puts the item last. INV-6 makes deriving `nextN` safe. It's named in `AGENTS.md` beside the reducer, with a guard spec.

**Emitters, from a sweep of `server/`, `shared/` and `tools/`:**

| Emitter | Change |
|---|---|
| `addItem` (`runtime.mjs`) | `item.n = nextN(thread)`, from `store.pending.items` (#601) |
| `bringForward` (`runtime.mjs`) | `item.move` carries `n` for the moved item; the stub takes the old `n`. An item already last is only patched and keeps its `n` |
| `seedBigRoom` (`tools/uat/big-room.mjs`) | passes `n` as `addItem` does |

**The reducer and load:**
- A missing `n` takes `nextN`, which is `(last item's n) + 1`. That holds by INV-5 and INV-6, and replaces §6.1's header counter.
- `ownState` numbers old items in list order.
- The server computes `n` for every new event. The browser computes it only for data from before the upgrade, by the same shared rule, and a spec checks that the page's numbering equals the server's.

**Readers that rebuild order from events:** `server/remote/turns-snapshot.mjs` and `tools/uat/history.mjs` keep list order.

**Seams:**
- `n` needs no new entry in `EVENTS`. B1a moves the rule into `EVENTS['item.add']` and `moveItem()`, and updates the frozen cases in `tests/state-events.test.mjs`.
- #632's reducer-contract spec gets one `VALID` `item.add` payload with `n` and one without.
- A1b's `folded.before` and `read_conversation { before }` read `n`.

**Specs, failing first:**
- replay numbering;
- INV-5 under moves;
- the INV-6 guard;
- a held add;
- `seedBigRoom`'s `n`;
- the `ownState` agreement.
