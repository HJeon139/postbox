# #712a: the page skips the items off screen

Part of #508's lane: a long room should perform like a small one. #712a is the page's half, and #712b (the reducer's lookups) is the script's. The reviewed design was revision 2 of the #712 note, with critic's six conditions and the jump addendum. This file records what was built, and where it differs from that design.

## The rule

- **Every item stays mounted.** `.transcript.cv-skip > .item` gets `content-visibility: auto; contain-intrinsic-size: auto 71px` (91 px under 600 px). Those are the median item of a generated 1,000-item room (`app/workbench.css`).
- **The browser skips the layout and paint of items off screen.** It lays each one out at the estimate until it draws, and then remembers the item's real size.
- **Nothing is unmounted,** so focus, drafts, app frames and find-in-page keep working. Find-in-page draws the item it finds, as the browser does for a skipped item it matches (`view-skipped.spec.mjs`, “find-in-page finds a word only a skipped item has”).
- **Where it applies:** only where `CSS.supports('content-visibility', 'auto')` (`app/js/view-skip.mjs`), and only in the main pane. A side panel's box changes width going full screen and back, and its skipped items in view then draw at the new width over the frames after: the browser clamps the view again once the new size is seen, and #837's rule takes that for you reaching the end (`work-pane-thread.spec.mjs`, the two near-end cases at 1280 px).
- **An item with a fixed descendant is never skipped:** a full-screen review, a full-screen app, or an app's check frame (`:has(.rv-full, .app-full.fullscreen, .check-frame)`). Skipping contains layout and paint, so the item would become the box those are placed in.

## Keeping your place (B1b's view state)

- **Each draw is heard.** An item drawing for the first time changes size, and the view holds its anchor through `follow()`. The view hears that from the transcript's ResizeObserver, and from `contentvisibilityautostatechange` on the transcript, in capture.
  - **Why the event is needed:** while following, the transcript holds the room below its newest message as bottom padding (`--held`). An item drawing inside that held room changes nothing the observer sees, so the anchor would go stale, and the next resize would apply the stale correction as a scroll. `composer-grow.spec.mjs` "#422: scrolled up" fails without the listener: the message you read moves 27 px.
  - **Nothing is observed per item.** Revision 2 observed each drawn item; the draw event alone is enough.
- **A jump makes its target the anchor.** `jumpTo(el, block)`, in `app/js/view-jump.mjs`:
  - it measures the target with its item drawn;
  - it puts the target where `block` says, in the part of the view you can see, below the main pane's sticky top bar;
  - it pins the item as the anchor (`pin()` in `view-state.mjs`) until you scroll, so the items it passed can draw at their real size without pushing it away.
  - **The item stays drawn until painted,** so a target deep inside a tall item isn't skipped again.
  - **Every jump to an item goes through it:** seven sites in `app/js/`, and the UAT runner's own jumps. `tests/view-jump-sites.test.mjs` fails on any `scrollIntoView`, or any `focus()` without `preventScroll`, outside the allowed list.
- **A message appended while you follow is drawn at once,** one at a time (`drawNewest`, `app/js/view-skip.mjs`), so the view goes to the end once, at its real height. Drawing the next lets the one before be skipped again, so a burst of replies doesn't stay drawn.
- **A reading view at the end was put there, not taken there by you** (`onScroll`). After the box changes size and clamps the view to the end (#837), the items that come into view draw from their estimates, and holding the anchor through that can move the view down to the end. Only your own scroll (one the transcript didn't make) reaching the end follows it, and a reading view at the end keeps the anchor you read at (`view-skipped-width.spec.mjs`: the window 500 px taller, read 400 px up).
  - **The side panel still fails #837's two near-end cases with skipping on,** with this rule in too, so it stays unskipped. Why isn't found yet.
- **The smooth jump to the end stays smooth.** While it runs, `follow()` doesn't snap to the end. On `scrollend` it goes the rest of the way, unless input that can scroll the page came while it ran: a wheel turn, a touch, a press on the scrollbar, or a scroll key outside a field (`app/js/view-smooth.mjs`). Then you stopped it, and the view reads where it stopped. A jump to an item during it ends it (`halt()`), and puts the item in place again a frame later, since Chromium still applies one more step of the smooth scroll then.
  - Without `scrollend`, or with reduced motion, it jumps at once.

## The checks

- **`rows-skipped`** (`tools/uat/checks-view.mjs`) fires when fewer than half of a room's items are skipped, in a room of more than 1,000. The probe (`tools/uat/skip-probe.mjs`) samples each step, before any screenshot draws an item.
- **The specs:**
  - `view-skipped*.spec.mjs`: the estimates, V3, find-in-page, Tab out of an app, and the smooth jump;
  - `view-jump*.spec.mjs`: jumps at 10,000 items, a diagram item, and a target deep in a tall item;
  - `view-jump-sites.spec.mjs`: each site through its real control.

## The test harness

- **Playwright's trace snapshots** read every element's scroll position around each action. In Chromium, each read inside a skipped item lays that item out, about 150 ms per snapshot at 200 items.
  - So specs that count layouts, and specs on rooms of 1,000 or more items, turn snapshots or tracing off, each with a comment.
  - The page itself lays out nothing while idle.
  - Measurements must be taken without snapshots.
- **Playwright's `scrollIntoViewIfNeeded`** on an element inside a skipped item scrolls to the item's estimate. The page's own `scrollIntoView` and `jumpTo` don't do that.

## Not done here

- Unmounting items far from the view. The rule keeps every item's DOM node in memory.
- WebKit isn't in the browser runs, so its fallbacks are untested: no `scrollend`, and no `checkVisibility` option.
