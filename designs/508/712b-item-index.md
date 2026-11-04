# #712b: one item index, outside the state

Part of #712 (#508’s B1): the server’s and the page’s half, beside #712a’s browser half. Cited at `main` `040ded68`. A reviewer’s first read found that an index kept in the store’s state would break the snapshot (`JSON.stringify` turns a `Map` into `{}`) and reach `/api/state`; this design adds nothing to the state.

## What’s true today that the design rests on

- **An items list only ever grows at its end, or has one entry replaced in place.** The reducer appends on `item.add` (`shared/state.mjs:148`). `item.move` splices a stub, with a new id (`server/runtime.mjs:326`), into the item’s old place, and pushes the item last (`state.mjs:177–183`). Removing a thread deletes its whole list (`:191–196`). Nothing removes a single item, so **positions never shift**.
- **Outside the reducer, nothing writes to a live list.** `git grep` over `server/`, `shared/` and `app/` finds three other writes, none to a store list: `telemetry-report.mjs:40` writes to its own copy, `broker-snapshot.mjs:67` writes to the host’s snapshot, and `tools/uat/big-room.mjs:118` writes before load. A held view (`server/store-held.mjs:117–118`) replaces an entry with a `structuredClone` with the same id, in its own copy, and then goes through `apply`.
- **Lists are replaced wholesale** on load (`ownState`, `store-recover.mjs:62`; the page’s `client.mjs:41`), on Retry, and by each held view’s copy (`store-held.mjs:96`).

## The design

`shared/item-index.mjs` (new, about 40 lines):
- **`const INDEX = new WeakMap()`**, from an items array to `{ at: Map<id, position>, seen: number }`. It’s keyed by the array itself, so it’s never in the state, never serialized, and never sent. A list that’s replaced or dropped takes its index with it (the WeakMap lets it go).
- **`positionOf(list, id)`**, the one lookup:
  1. Index any new tail: positions `seen` to `list.length − 1`. That’s amortized O(1) per append, and O(n) once for a list that’s just been loaded.
  2. Look up `id`. **On a hit, verify** that `list[p]?.id === id`. If not, rebuild once, and count the rebuild.
  3. Return p, or −1.
- **First match wins, as `.find` does today.** An id is indexed at a new position only if its old one no longer holds it.
- **`itemOf(list, id)`** is `list[positionOf(list, id)]`.
- **`noteReplaced(list, p)`** is called by `moveItem` after its splice, so the stub’s id is indexed at the old place. The pushed item is picked up as a new tail. A move with no stub leaves `undefined` there, as before, and `noteReplaced` skips it, so the reducer still never throws after a write (#632).
- **`store.pending.item(t, id)`** (new) reads one item with held emits applied: from the held view’s own entries while a commit is held, which the index keeps exact as held events apply, else from the published list. **`itemIn(t, id)`** and **`placeIn(t, id)`** in the page’s `client.mjs` do the same for the page’s state.

**Readers switched** (a one-line change each, `find`/`findIndex`/`some` by id on a store list → the index):
- **Per event, both sides:** `withItem` and `moveItem` in `shared/state.mjs`. That’s every `item.patch`, `item.text` and `item.move`, on the server and in the page, which runs the same reducer.
- **Per event, page:** `thread.mjs` `rerender`, `:355` and `updateText`, `reactions.mjs:73`, `reply-rings.mjs:53`, and `hover-content.mjs` and `side-panel.mjs`.
- **Per call or per flush, server:** `store.item` (`store.mjs:306`, 20 callers), `store-held.mjs:117`, `catch-up.mjs:17`, `:46`, `queue-batch.mjs:30`, `share-back.mjs:20`, `topic-open.mjs:18`, `runtime.mjs` (a shell command’s output flush, every 100 ms, and its exit; a job’s step; the terminal mirror), `side-threads.mjs:63`, `permission-prompt.mjs:29`, `thread-summary.mjs:62`, `shared/needs.mjs:26`.
- **Left as they are, each with its reason:**
  - `thread-summary.mjs:105`’s `indexOf(item)` is by object;
  - `room-checks*.mjs` read recorded facts, not the store;
  - `broker-reading.mjs:47` reads the host’s snapshot;
  - `runtime.mjs:319` (a move) and `:1022` (each turn’s end, beside a whole-list `filter`, so the index wouldn’t change its cost); `runtime.mjs` is at its size cap;
  - `thread.mjs`’s move stub (`:340`), on each move.

  The scans for anything other than an id (`speaker-line`, `open-asks`, the flush loops in researcher’s list) are out of scope, named in the PR.

## Invariants

- **I1. Exact:** for every list L and every id x in L, `positionOf(L, x)` is the first position holding x, and it’s −1 for every other id. A scripted mix of every event kind checks it against `findIndex` after each event, plus a load, a Retry, a held view and a thread removal.
- **I2. Not state:** `JSON.stringify(state)` and `publicState(state)` are byte-identical with and without lookups having run. That’s the reviewer’s round-trip test, on the server and in the page.
- **I3. Self-healing, never wrong:** the hit check makes a stale index cost a rebuild, never a wrong item. A test mutates a list behind the index’s back (an in-place replacement with a new id), and the lookup still returns the right answer, with the rebuild counted. Normal flows rebuild 0 times, and a test asserts that over the scripted mix.

**The contract’s edge:** a write outside the reducer that puts a *new* id in place, at a position already seen, gives a miss until the list is indexed again. No such write exists (above). I3’s test pins the hit side, and the module’s header states the contract.

**Two behavior changes, both at the edges:**
- **A hole in a list** (a move with no stub, or an `item.add` with no item): on `main` a later patch or text to an item after the hole threw in `.find` and was rejected (#609); now it applies.
- **Duplicate ids after a move:** on `main` `.find` took the first copy; the index takes the stub’s place. Ids come from `newId`, so neither happens in practice.

## Cost

- **Per lookup:** O(1), using a Map.
- **Per append:** amortized O(1).
- **Per loaded list:** O(n) once, on the first lookup.
- **Memory:** one Map entry per item, only for lists that have been looked up. A held view’s frozen copies aren’t indexed: `pending.item` reads the view’s entries.
- **The count spec:** a list wrapped in a Proxy counts element reads per `item.text` at 1,000 and 10,000 items. Today that’s ≥ 1,000 (it’s 10,000 at 10×). After, it’s ≤ 2, plus O(n) once for the first event after load. The test fails first on `main`.

## Restart, reload and Retry

| Case | Today | After |
|---|---|---|
| Restart | `ownState` builds new lists; each `.find` is O(n) | New lists, so a new index on the first lookup; O(n) once per list |
| Store Retry | A reload, as above | As above |
| A held view | `findIndex` per held event (`store-held.mjs:117`) | Its own copy gets its own index |
| Page `load`/resync | `client.state` replaced | As above, in the page |
| Thread removed | Its list deleted | The WeakMap lets its index go |
| Snapshot | `JSON.stringify(state)` | Unchanged: the index isn’t in the state (I2) |
| An older or newer build | — | No format change, so nothing to downgrade |

## Tests that fail first, and mutants

- **Fail first:** the count spec, on `main`. I1 and I2 pass on `main` by construction, so they’re regression guards.
- **Mutants:** one for each of these, and each must fail a test:
  - remove the hit check;
  - remove `noteReplaced` in `moveItem`;
  - make the last match win;
  - skip the tail step;
  - put the index on the state.
- **Timings:** `item.text` on the newest item at 1×, 4× and 10× (1,000, 4,000 and 10,000 items), before and after, through the reducer the server and the page share: 11.1, 40.8 and 51.8 µs per chunk on `main`, against 0.40, 0.17 and 0.09 µs. The measurement with agents streaming (#712a’s condition 5) runs on the merged head.

## Size

`thread.mjs` and `runtime.mjs` are at their caps, so neither gains a line: the page’s readers go through `client.mjs`’s `itemIn` and `placeIn`, and the server’s through `store.pending.item`.

## Not here

The scans by anything other than an item’s id, and the whole-list renders, go in a follow-up issue with their evidence: `catch-up.mjs:23`, `read-message.mjs:22`, `thread-summary.mjs:93`, `:106`, `:184`, `:211`, `thread.mjs`’s moved line, `apps.mjs`’s retired line, `threads-page.mjs:52`, `topic-open.mjs:93`, `:95`, and `block-show.mjs:54` and `blocks.mjs:199` (by block id, on each show and update). The dead `store.findItem` is removed here.
