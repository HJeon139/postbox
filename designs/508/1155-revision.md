# Revision 13 of #508: under 100 ms at a million items (#1155)

| | |
|---|---|
| **Status** | Draft r4: the person's answers of 10 November are written in (“Choices for the person”). All five are decided; the person confirmed C5 separately. Nothing here is built. |
| **Revises** | `designs/508/design.md`, revision 12: §3 (G1), §5 (Architecture), §6.3, §10 (Browser), §11 (the PF-1 budget), §14 (Rollout, track B) and §18 (Decisions). `designs/508/requirements.md`: §5 (Large rooms) and Storage. `designs/508/storage-design.md`: §6.9 (S2's trigger). Where this file and those differ, this file wins until they are edited to match. |
| **The target** | Approved by the person on 10 November 2026 (`sprint4/perf-principles-approved.md`; #1155). Every interaction paints within 100 ms, p95, from input to the next paint, in a conversation of a million items, in Firefox and Chromium, on the person's Mac. The page draws what can be seen plus a screen either side, never the whole conversation. |
| **Not in it** | The doc changes to `intent.md`, `architecture.md`, `engineering-practices.md`, `review-guide.md` and `developing.md` (items 1 to 6 of #1155). Those are one docs PR after this revision is decided. |
| **Code baseline** | `main` at `957d8961`. |

## 1. Summary

Revision 12 decided on 2 November that client-side virtualization comes first, and that the server window (B1a positions, B2's items API, B3) waits for a measurement showing virtualization misses PF-1. That measurement is now in, and it shows two things.

**Once a room is open, the window holds.** With #1075's window, a 10,000-item room keeps about 1,150 elements on the page. Switching to it takes 109 ms, and typing and new messages stay under 30 ms (§2, table 1). Viewport rendering, mounting one screen either side instead of 200 items, makes that cheaper still and bounds it by the window's size, not the room's.

**What grows with the room is the whole-state model.** The window can't touch any of these:
- **Start-up:** 0.7 s at 1,000 items, 10 to 15 s at 10,000, about 80 s at 30,000. The page loads every conversation's state before it draws one.
- **The server's state:** at 100,000 items it can't be built as one string at all. `/api/state` fails with `RangeError: Invalid string length`.
- **The store:** past about 68,000 items the snapshot fails, the log stops rotating, and a restart can't load (#1180).

So this revision changes three things:
1. **The page draws only what's seen (§4).** Viewport rendering with one screen of overscan replaces the 200-item window. It runs under a page-wide budget of about 5,000 elements, and long items are windowed inside themselves.
2. **The page doesn't hold the conversation (§5).** It fetches items by range. B1a, B2 and B3 (#531 to #533) come back now, as the way it does that, and start-up loads headers, not items.
3. **The store answers from indexes (§6).** Snapshots are sharded, a conversation's items live in fixed-size blocks on disk, and the server keeps a bounded hot set in memory. Start-up reads headers and indexes. #1180's line-based snapshot is the first step.

It also says where #305's read side fits (§7), what the budget spec gates (§8), and the order (§9). Section 10 lists the choices that are the person's.

## 2. Evidence

**Table 1: the budget spec (#1166), `main` against #1075's window.** These are one run each, in the Chromium headless shell on the x86 build host, at a 1-minute load of 28 to 69, on the big-room seed (#1017) with `work: true`. They are lead-transcript's corrected numbers on #1155 (comment of 10 November, 09:04 UTC). None of them gate; the reference Mac's will.

| | `main`: 1,000 / 10,000 / 30,000 items | Window (#1075 at `649a547f`): 1,000 / 10,000 / 30,000 |
|---|---|---|
| Start-up, load to the first room drawn | 0.7 s / 10.4 s / 78 s | 0.8 s / 14.9 s / 84 s |
| Switching to the room, p95 of 5 | 413 ms / 3,967 ms / 10,849 ms | 90 ms / 109 ms / 89 ms |
| Elements on the page (budget 5,000) | 22,355 / 220,766 / 662,191 | 1,093 / 1,153 / 1,123 |
| Key to paint, p95 of 40 | 16 ms / 184 ms / not run | 24 ms / 24 ms / not run |
| A new message while following, p95 of 20 | 23 ms / 639 ms / not run | 24 ms / 28 ms / not run |
| A one-screen scroll, p95 of 20 | 16 ms / 296 ms / not run | 40 ms / 16 ms / not run |

**Table 2: the Mac baseline on `main`.** Researcher's asset `sprint4/budget-baseline-mac-2db29f2e.md`, v2, at 1,000 and 10,000 items, in Chromium and Firefox 157, with no other timed run on the Mac.
- **The key rows are void.** “Key to paint” and “longest task, key to paint” came from the probe before lead-transcript's two fixes: late entries counted as fast, and Chromium's full headless mode presented no composer frames. They are not used here.
- **What stands:**
  - mounted elements: 22,355 at 1,000 items and 220,766 at 10,000, in both browsers;
  - opening: p95 1.0 s in Chromium and 1.8 s in Firefox at 10,000 items;
  - a new message in Firefox at 10,000 items: p95 149 ms, a fail;
  - the longest task around a new message in Chromium at 10,000 items: 104 ms, a fail.

**Table 3: the store's limits (#1180).** A probe on `main` at `dd699ece`, with the same seed:

| | Result |
|---|---|
| State per seeded item, in memory | 7,836 characters, steady from 1,000 to 30,000 items |
| The snapshot, as one `JSON.stringify` | fails near 68,500 items (V8's 536,870,888-character string limit); the last good one was 507 MB |
| A segment read whole by `replaySegment` | Postbox can't start once a segment passes about 536 MB |
| The person's own `snapshot.json` | 171 MB, about a third of the limit |

**What a million items would cost today.** At 7,836 characters an item, a million-item conversation's state is about 7.8 GB in memory and in its snapshot. That's 15 times V8's string limit. So no change to how the state is serialized makes the whole-state model reach the target: the server can't hold that conversation's items in memory either. Section 6 follows from that number.

**The shape of a real room** (researcher's `sprint4/room-shape.md`, this room on 6 November): 67% agent replies, with a median of 1,008 characters and a largest of 19,687; 11% blocks, with reviews the largest at a median of 6,981 characters. The seed's mix is calibrated to that shape (#1017).

## 3. What changes in the requirements

`requirements.md` §5 is revised as follows. The checks are the budget spec's (§8).

| Id | Requirement (revised) | Check | Was |
|---|---|---|---|
| PF-1 | Every interaction paints within 100 ms, p95, from input to the next paint, in a conversation of a million items, in Firefox and Chromium, on the reference Mac. The interactions are a key in the composer, a new message arriving while following, a one-screen scroll, opening or switching to a conversation, and opening or closing a pane. | The budget spec at 1,000, 100,000 and 1,000,000 items. | Key-to-frame within 10% of a small room's, up to 10,000 items |
| PF-10 (new) | The page holds at most about 5,000 elements, whatever the room's size. A long item counts its mounted part, not its whole. | The spec counts mounted elements after each measure, and the lag log (#1145) reports the count. | — |
| PF-11 (new) | Start-up doesn't grow with the rooms' items: Postbox starts, and draws the first room, in a time set by the number of conversations, not their lengths: at most 1 s, p95, at any size, on the reference Mac (C4, decided). | The spec times start-up at each size. | Not stated |
| PF-12 (new) | No size of a room stops the store from writing its snapshot, loading at start, or answering a read. A write costs in proportion to what it changes. | Store cases at past the string limit (#1180), then at a million items. | Not stated |
| PF-8 | The person can find a message by its words in a long room. Since the page no longer mounts the room, this is required, not conditional. | A word in an item far outside the mounted range is found, and opens at it. | “Needed only if loading less of the room breaks find-in-page” |

PF-2 to PF-7 and PF-9 stand unchanged. PF-9 matters most here: no runtime dependency is added, so the store's indexes and blocks are written in Postbox, on JSON Lines.

## 4. The page draws only what's seen

### 4.1 Viewport rendering, on the window's machinery

#1075's window already has the hard parts:
- B1b's explicit view state;
- stubs for unmounted items;
- islands for pinned items;
- the move and patch rules for items outside the range;
- interactive state kept across unmounting (#494).

What changes is the range policy:
- **Before:** about 200 items around the anchor.
- **After:** the items that intersect the viewport, plus one viewport's height of overscan above and below. In a normal window that's about 3 to 10 items.

The range is recomputed after each scroll frame and each height change, never on a timer.
- **Pinned items stay mounted outside the range,** as today: one that holds focus, a dirty review or form, or an app frame with unsent input. They count toward the element budget, and they're released when the interaction ends.
- **Following the newest item:** the tail is mounted, plus one screen above it. A new message mounts one item and unmounts what scrolled out. The work is bounded by one screen, not by the room.
- **The cost of a scroll:** proportional to the items entering and leaving, at most two screens.

### 4.2 Heights

Each item gets an estimated height before it is ever mounted.
- **The estimate:** by kind and text length, with constants tuned on the seed and recorded in `shared/limits.mjs` (MS-3).
- **Once mounted:** its height is measured by ResizeObserver and kept by `id` and revision, in a map bounded by the loaded range.
- **The scrollbar:** spacer heights are the sum of the estimates and measurements, so the scrollbar is roughly right without mounting anything. That's the same mechanism the window's stubs use today (`712a-skipped-items.md`).
- **When a measurement corrects an estimate,** the view state re-anchors (B1b), so what you're reading doesn't move (PF-3).
- **The thumb can shift** by the error of the estimates above the view. The person accepted that with gray placeholders (C2, decided).
- **Geometry is read before any write, once a frame.** ResizeObserver entries give the sizes, not `offsetHeight` reads after a write.

### 4.3 The element budget

There are about 5,000 elements on the page in all: the transcript's mounted range, its pinned items, the side panes, and the chrome.
- **The budget is a gate, not a goal:** the budget spec fails past it, and the lag log reports the count with each slow event (#1145).
- **In the window's measurements,** the page held about 1,100 elements at every size, so viewport rendering sits well inside the budget. The budget is there to catch the next feature that mounts something off screen.

### 4.4 Long items are windowed too

An item whose own content can run long draws only its visible part:
- **A tool run's activity steps (`activity-paint.mjs`)** mount the steps in view plus overscan.
- **A review's content** mounts its sections in view. Its marked ranges are kept by offset, so a comment on an unmounted section isn't lost.
- **A table block** past a row threshold mounts its visible rows.
- **A long agent reply** stays whole. At 19,687 characters, the largest in this room, it is about one screen of elements, which is within the budget, so it isn't split.

Each long item uses the same range rule as the transcript, inside its own scroll extent. The item's height is still known, so the transcript's spacers stay right.

### 4.5 Work for each event is bounded by what's on screen

- **An item event for an item outside the loaded range** updates only the cached header, height and counts, and draws nothing.
- **Inside the loaded range but not mounted,** it updates the cached data.
- **Mounted,** it patches that item's DOM.
- **Nothing is rebuilt from every item.** Highlights are rebuilt at most once a frame (#1151, whose fix is #1159, in review), and `CSS.highlights` holds one entry for the whole view.
- **No inherited custom property changes high in the tree.** A value read inside the transcript is set on the element that reads it, or registered with `@property { inherits: false }`. These were the cases found: `--held` (#1150, whose fix is #1181, in review) and `--pane-w` (#1168, merged).
- **App frames load only when seen.** An unmounted app is a stub with its height. Its `app.check` still runs on the server (PF-7, unchanged).

## 5. The page fetches by range

### 5.1 What the page holds

- **`/api/state`** carries what it carries today except items. That's thread headers with `nextN` and stats, app headers, sessions, open records once A2 builds them, settings, and the work list's headers. Start-up is then proportional to conversations and open records, not to items (PF-11).
- **For each open conversation,** the page holds a loaded range: one contiguous run of items by position (B1a's `n`), wider than the mounted range.
  - It's loaded a page at a time, 60 items to start, a tuning value as in §11 of `design.md`.
  - The next page is fetched when the mounted range comes within one page of the loaded range's edge.
  - The far end is dropped when the loaded range passes a bound (draft: 1,000 items, MS-3).
- **The items API (B2):**
  - `GET /api/threads/:id/items?before=<n>&limit=<k>`, `?after=<n>` and `?around=<itemId>`, each returning items with their `n` and the `seq` they're current at.
  - Each projection keeps its own watermark, and each page request carries a generation (`design.md` §10, unchanged).
- **The stream** is filtered by open conversation (B2, unchanged). An item event outside a conversation's loaded range is applied to the header's counts only.

### 5.2 Jumping and finding

- **A jump** replaces the loaded range with the page around the target (PF-4, as `design.md` §10 says). That covers an `m=` link, Next needs you, an open ask, a search hit, or Jump to latest from far back.
- **Dragging the scrollbar far** fetches the page at the position the thumb implies. Positions are dense, so `n` maps to a scroll offset within the estimates' error. Until the page arrives, the spacers keep their heights and the view shows gray placeholders at those heights (C2, decided).
- **Finding a message (PF-8):** the browser's find-in-page sees only mounted text, so Postbox's own search goes to the server, and a hit is a jump. It's opened from the existing search in the conversation's top bar (`searchButton` in `app/js/search-dialog.mjs`, “Search this conversation…”), with no new box and no shortcut (C1, decided).
  - **What changes in that search:** today it searches an index the page builds from the items it holds (`indexFor` in `app/js/transcript-search.mjs`, #866 W4). Once the page holds only a range, that index can't see the room, so the field sends its query to the server and shows the server's hits, with the same snippets and the same jump. The field, its results list and its keyboard behavior don't change.
  - The server's index can't be built per query at a million items. `shared/bm25.mjs` builds its index in O(items), and revision 12 built it on demand.
  - So the index is kept per block (§6.2), updated when a block changes, and searched block by block. A query costs O(blocks × terms) plus the hits read.
  - T-S3 measures it at a million items before it gates.

### 5.3 What the page no longer derives from items

Some page modules read `client.state.items` to find something across the room. Each moves to a server-side derivation it reads from the headers:
- **The needs-you list** (`shared/needs.mjs`) and **open asks** (`app/js/open-asks.mjs`). INV-8 already asks for this.
  - Until A2's records exist, the server derives them from its own state and sends them with the headers.
  - The server still holds every item until §6.3 lands, so this is a move of where the derivation runs, not a new data source.
- **The topic and side-thread counts** come from the headers.
- **The app checks** already read `client.state.apps` (#495).

The window's single-reader rule (INV-8) is how this is checked: only the window module reads items. A grep test, like the held-view guard (`tests/store-held-guard.test.mjs`), fails a second reader.

## 6. The store answers from indexes

### 6.1 Why the whole-state model ends

`store.state` holds every item of every conversation. A million-item conversation is about 7.8 GB of it (§2), past V8's string limit 15 times over, and far past a Mac's comfortable process size. So the end state is not a faster way to serialize that state: it's a store that keeps a bounded hot set in memory and the rest on disk, by block.

### 6.2 Item blocks

- **Blocks:** a conversation's items are kept in blocks of consecutive positions, bounded by bytes, not by count. The draft is 4 MB a block, with the newest block kept small (draft: 256 KB) and sealed into the older blocks as it fills. Both are tuning values (MS-3).
- **Each block is one file** under the sharded snapshot, written as JSON Lines: a header line `{ v, convId, firstN, lastN, firstAt, lastAt, ids }`, then one line per item.
- **A block is rewritten only when an item in it changes,** by the same draft, sync and rename as today's snapshot.
  - Most changes land in the newest block, which is small, so a streaming reply rewrites at most 256 KB at each snapshot. A patch, revision or move of an old item rewrites its one block.
  - A snapshot's cost is then proportional to the blocks touched since the last one, each bounded by bytes, not to the conversation (PF-12). By count, 4,096 items at about 7.8 KB would have made the newest block about 32 MB, rewritten for one changed item.
- **The sharded snapshot (S2), brought forward:**
  - a manifest names the current file for each conversation's header shard, each item block, and each non-item collection (sessions, apps, records, settings);
  - it is renamed into place last, so a crash leaves the old set in use (`storage-design.md` §6.9, the shape agreed then);
  - the rollback guard is `snapshot.json` as a folder (Q7 there).
  - **What changes from revision 12:** S2 no longer waits for a 50 ms stall, since the limit is now correctness, not a stall.
- **The log:** the event log is unchanged, one line per commit, replayed from the manifest's `seq`. #1180's line-based replay is the first step, and it reads a segment of any size.

### 6.3 The hot set and the index

In memory, the server keeps:
- thread headers;
- sessions, apps, open records and settings;
- for each conversation, its newest block, its index, and a least-recently-used cache of other blocks, bounded by bytes (draft: 256 MB in all, MS-3).

**The index for each conversation:**
- the block list, with each block's `firstN`, `lastN`, `firstAt` and `lastAt`;
- a map from item id to `n`.

**Its cost at a million items:**
- the id map is about a million short strings, measured before it gates (T-S2);
- a range read by `n` is a binary search over blocks, O(log blocks), then one block read if the block isn't cached;
- a read by time is the same search on `firstAt`, since items are appended in time order;
- a read by id is O(1) to its `n`, then a range read.

**What this changes for code that reads items:** `store.items(threadId)` and `store.pending.items(threadId)`, which return a conversation's whole list today, become range reads. The held-view guard (`tests/store-held-guard.test.mjs`) already lists every reader of `items` and `work` by file and function, in its published, direct and pending tables. That inventory is the work list for this step, with two more sources the guard doesn't see: a grep for `state.items` and `s.items` outside the store, and the tools that read `snapshot.json` directly, `tools/bench-snapshot-stall.mjs` and `tools/measure-archive-policies.mjs`, as lead-state found for #1180. The readers:
- **Readers that need only the newest items:** the turn envelope, the catch-up, endWork's last reply. They read the hot block.
- **Readers that need one item by id:** `read_message`, blocks, reactions. They read through the index.
- **Readers that walk the whole room:** room checks, telemetry, `read_conversation`'s paging. They read by range, a block at a time. `read_conversation` keeps its interface (#1155 item 3), and pages through blocks.
- **Readers that derive something across the room:** needs-you and open asks. They move to records, which is A2, or to a per-conversation summary kept with the header.

### 6.4 Start-up

Start-up reads:
- the manifest;
- the header shard;
- the non-item collections;
- each conversation's index and newest block.

Then it replays the log from the manifest's `seq`. A log event for an item in an older block loads that block, applies the event, and marks it dirty. Start-up is then proportional to conversations, open records and the log since the last snapshot, not to items (PF-11).

### 6.5 What stays as it is

- `commit` and `emit`, the one-line commit, fsync and recovery (`storage-design.md`);
- the held view;
- the history epoch and the lock;
- the reducer.

The reducer is shared with the page, and stays one function over the hot state. An event on a cold item is applied to that item's block, loaded first, by the same reducer case.

## 7. Where #305's read side fits

#305 moves old turns' work entries and reply activity out of the state into content-addressed archive files.
- **Under §6 it still pays:** activity steps are 28% of today's snapshot (`storage-design.md` §6.9), and the archive keeps them out of the hot block and out of every block rewrite.
- **The two compose:**
  - an item block holds a reply with its activity as `{ archived, count }`;
  - the archive file holds the steps;
  - the Work view's summary row and its turn route are the archive's.

So the read side's server half goes ahead now. It doesn't depend on what the page draws:
- the lookup helper;
- the work routes and the ledger answers' fallback (T-5);
- the totals (T-14);
- T-9 on the seed, which also measures the scan cost critic flagged on #1157.

**The Work view's archived-turn row is built on viewport rendering (§4)** once that lands: the Work list is long too, and gets the same range rule. Branch `feat/305-3-read` is rebased once for this.

## 8. The budget spec

#1166 is the gate. This revision fixes what it measures and when:
- **The measures:**
  - key to paint;
  - a new message while following;
  - a one-screen scroll;
  - opening and switching to a conversation;
  - opening a pane;
  - mounted elements;
  - the longest task around each measure;
  - start-up.
- **The sizes:** 1,000, 100,000 and 1,000,000 items on the big-room seed, with reviews, apps and long tool runs in the room's shape.
- **When it fails:** past 100 ms p95 (PF-1), past about 5,000 elements (PF-10), or past the start-up budget of 1 s p95 at any size (PF-11, C4, decided).
- **When it runs, and what gates where,** to match #1166 and #1185 as decided:
  - **On each PR** that touches `app/`, `server/store*`, or a reader the held-view guard lists: 1,000 and 10,000 items. An every-size run took 21 minutes in #1185, against #1166's ceiling of about 10.
  - **What gates there:** in CI, only the element count, and only once `main` passes it (#1185 keeps the spec off CI until then). Times gate only on the reference Mac's headed run, never on CI or the build host, whose load swings.
  - **Nightly:** 100,000 and 1,000,000 items, on the build host, in both browsers (C3, decided).
  - **When 100,000 moves onto every PR:** once start-up is bounded, at R4, since until then a 100,000-item room doesn't open (#1180).
- **The probes:** both browsers have Event Timing, `performance.now`, `requestAnimationFrame` and the lag log, so each measure runs in both. Critic's conditions on #1166's r3 stand:
  - a key whose entry outlasts two frame gaps is “not measured”, never a time;
  - the gating Chromium run on the Mac is headed, not the headless shell.

## 9. Order

Each step ships alone, with a spec that fails first on `main` and the full browser suite green (`design.md` §14's definition of done).

| Step | What | Depends on | Decided by, failing first |
|---|---|---|---|
| R0 | #1075, the window | — | merged, or at its last round |
| R1 | The docs PR, #1155's items 1 to 6 | this revision decided | the light gate |
| R2 | The budget spec (#1166), gating opening and elements above 10,000 items | R0 | #1150's and #1151's cases on commits before their fixes |
| R3 | #1180's fix (#1194): the line-based snapshot and replay, always lines (C5), with a `BREAKING CHANGE` footer and the rebuild tool | — | a state past the string limit snapshots and loads; a segment over the limit replays; a line-format file makes `main`'s reader refuse to start rather than start empty; the rebuild tool writes an old-format snapshot below about 68,000 items and refuses above |
| R4 | B1a positions everywhere, and B2: the items API, filtered stream, watermarks and generations; `/api/state` without items; needs and open asks from the server | R0 | B2's specs in `design.md` §14; start-up at 30,000 items under the C4 budget |
| R5 | Viewport rendering on the window: the range rule, heights by id, pinned items in the budget | R4 | the element count and switch time at 100,000 items; PF-3's 13 scroll specs |
| R6 | Long items windowed: activity steps, reviews, tables | R5 | elements with one 2,000-step tool run in view |
| R7 | The store's blocks, index and hot set; S2's manifest; readers behind range reads, by the guard's inventory | R3 | a million-item conversation snapshots, restarts and answers a range read; memory under the hot set's bound; T-S1, T-S2 |
| R8 | Server search, indexed per block, behind the existing top-bar search (PF-8, C1) | R7 | a word far outside the range is found and opens, within 100 ms at a million items (T-S3) |
| R9 | The million-item run, nightly | R7, R8 | the spec at 1,000,000 items in both browsers |

**Why this order:** R2 and R3 are each small, and remove a risk the person meets today. R4 is what ends start-up's growth for the page, and the page's half doesn't wait on the store's. R7 is the largest step, and it waits on nothing in R4 to R6.

**What it does to revision 12's steps:**
- **B1 to B3 (#531 to #533)** come back as R4 and R5, now, rather than waiting on a measurement. Their issues are rewritten to these rows.
- **PF-1's relative budget** gives way to the absolute one.
- **S2's 50 ms trigger** is dropped (§6.2).
- **A1b and A2 are unchanged.** A2's records remove the last cross-room readers in §6.3. Until then, those readers run on the server.

## 10. Choices for the person, and the person's answers

The person answered all five on 10 November 2026, in scrum-master's form. Each choice changes what the person sees or what they pay for; every other choice in this revision is technical, for critic and scrum-master. The options weighed are kept below each answer.

**C1. How the person opens Postbox's search, now that ⌘F/Ctrl+F finds only what's on screen. Decided: Postbox's own search, through the existing top-bar search, with no new box and no shortcut.**
- **The person's note:** “we already have a search box at the top bar. Please don't add a new search box.” So the existing “Search this conversation” field in the top bar sends its query to the server (§5.2). Nothing new is drawn in the conversation.
- *Weighed:* (a) Postbox's search with no new shortcut, chosen, amended by the note. (b) Postbox takes over ⌘F inside a conversation, which brings back a shortcut the person asked to drop. (c) The browser's find only, which can't find a message off screen.

**C2. What the person sees while a far part of a conversation loads. Decided: gray placeholders at the right heights.**
- They fill in when the items arrive. The scrollbar thumb can shift slightly as estimated heights are measured, but what's being read never moves.
- *Weighed:* (b) the view waits, then jumps, which feels stuck on a slow fetch. (c) Exact heights for every item, a pass over every item the target rules out.

**C3. Where the nightly runs at 100,000 and 1,000,000 items happen. Decided: on the build host, in both browsers.**
- Results go to the nightly issue. The reference Mac's headed run, which gates times, is the Mac check on each PR that touches what §8 lists. No paid runner time.
- *Weighed:* (b) In CI, which needs Firefox there (#670) and runner minutes each night. (c) Weekly, which lets a regression sit up to a week.

**C4. The start-up budget, from opening Postbox to the first room drawn. Decided: at most 1 s, p95, at any size, on the reference Mac.**
- That's today's start-up at 1,000 items (0.7 to 0.8 s, table 1), so R4 must load only headers at start.
- *Weighed:* (b) at most 2 s. (c) Parity with a 1,000-item room, which drifts with its baseline.

**C5. The snapshot format once #1180's fix (#1194) merges. Decided: always the new line format now.** The person chose it in the form and confirmed it when scrum-master asked again, since it wasn't the option recommended here.
- **What it means:**
  - snapshots stop Postbox for under 8 ms instead of about 0.26 s at the person's size, measured on the reference Mac (tester's probe; lead-state's table on #1155);
  - an older build that uses `~/.postbox` refuses to start on that folder, with “Couldn't read the snapshot”, and loses nothing;
  - #1194 carries a `BREAKING CHANGE` footer and a release note;
  - a case shows `main`'s reader refusing the new file rather than starting empty;
  - a tool rebuilds an old-format snapshot for going back, refusing past about 68,000 seeded items.
- **The background:** an older build reads `snapshot.json` with one `JSON.parse` (`server/store-recover.mjs:62` on `main`). R7's sharded folder is a second break of the same kind, asked again then.
- *Weighed:* the recommended option was to keep today's single-string snapshot while `JSON.stringify` succeeds, switching to lines only on `RangeError`. That breaks no older build until a room passes the limit, at the cost of two writer paths and a stall of about 0.26 s at the person's size, roughly 0.65 s near the limit (estimated).

## 11. Tests owed, failing first

| # | Test | Step |
|---|---|---|
| T-S1 | A million-item conversation: snapshot, restart and a range read each work, and the snapshot after one new item rewrites only the newest block, under its byte bound | R7 |
| T-S2 | Memory at a million items stays under the hot set's bound plus the index, measured and recorded | R7 |
| T-S3 | Search across a million items answers within 100 ms p95, and a hit far outside the range opens at it | R8 |
| T-P1 | Mounted elements stay under 5,000 at 1,000,000 items, scrolling from the newest to the oldest | R5 |
| T-P2 | Following at a million items: a new message mounts one item and unmounts what scrolled out, and none is rebuilt | R5 |
| T-P3 | A height correction above the view doesn't move the anchor (PF-3) | R5 |
| T-P4 | A 2,000-step tool run in view mounts only its visible steps | R6 |
| T-P5 | Start-up at 30,000 and 100,000 items is within C4's budget | R4 |
| T-P6 | A second reader of `client.state.items` outside the window module fails the grep guard | R4 |

## 12. Risks

- **R7 changes the store's read model.** Every reader the guard lists moves to a range or an id read. That is the largest change since 1a, so it is its own design note before code, with the guard's inventory as its checklist.
- **The id index at a million items** may not fit the hot set's bound. If T-S2 shows it doesn't, the index moves into the block headers, with a per-conversation Bloom filter to find the block. That's a technical fallback, not a choice.
- **Search by block** may miss the target at a million items in a single conversation. T-S3 decides that before R8 ships.
- **Estimated heights** make the scrollbar approximate (C2). Measured heights are kept by id, so the error only shrinks as the person reads.
- **The headless shell isn't the person's browser.** The gating Chromium run on the Mac is headed (§8).

## 13. Sources

- **#1155:** the issue, and lead-transcript's corrected comment of 10 November (table 1).
- **#1166:** the budget spec, and its design note `sprint4/1166-budget-design-r1.md`, v2.
- **#1180:** the store's limits (table 3).
- **`sprint4/budget-baseline-mac-2db29f2e.md`, v2:** researcher's Mac baseline (table 2). Its key rows are void.
- **`sprint4/perf-principles-approved.md`:** the approved target.
- **`sprint4/room-shape.md`:** this room's shape.
- **`designs/508/design.md`**, revision 12: §10, §11, §14 and §18.
- **`designs/508/storage-design.md`:** §6.9 and Q7.
- **`designs/508/712a-skipped-items.md`:** the window's stubs and spacers.
- **`designs/305-archive-turns.md`:** #305.
- **PRs:** #1075, #1159 and #1181 (in review), and #1168 (merged).
