# Prompt: wave 5, the right pane and narrow windows (#197, #86, #122, #7)

A wave 5 session. The triage session integrates it, and the architectural review session reviews it. Follow [README.md](README.md) for the rules every session shares. Your ports are 4950–4999 for servers and 10250–10299 for Chrome.

---

You’re making the right pane share the window with the conversation without squeezing it, on the branch `fix/w5-pane`, in one pull request with one commit per issue.

## Why

- **#197:** at 800 px with the sidebar open, opening Work leaves the conversation 112 px wide, a reply 26 px (about a word per line) and the composer’s text box 8 px. At 1024 px the text box is 129 px (manual UAT, 23 October 2026). intent.md keeps Work open “wherever the window is wide enough for the pane to sit beside it”, but nothing checks that it is.
- **#7:** at 1280 px with the sidebar and a thread open, an app in the transcript gets about 590 px, close to the width its check tests as a phone. Apps are the product’s distinctive output, and “Reply in thread” under an app is the common case.
- **#86:** the pane’s width is fixed. Long agent summaries with tables are hard to read in it, and widening it is the only way to trade width between the two (wave 1 manual UAT).
- **#122:** a thread open in room A is closed when you come back from room B. Work already stays open per conversation; threads don’t.

## Read first

- [README.md](README.md); `designs/intent.md`, Layout (the right-pane row); `designs/architecture.md` §14’s “Where it shows: the right pane” (`--pane-w`, `pb-work-<id>`, `pb-pane-split`, the 768 px rule).
- Each issue with its comments. #86 has a suggested handle design and acceptance.
- `app/js/pane.mjs`, the routing in `app/js/ui.mjs`, the rail’s collapse in `app/js/shell.mjs`, and the pane rules in `app/workbench.css`.

## The work

- **#197 and #7, one rule for width:**
  - Give the conversation column a minimum, at which a reply’s text and the composer stay usable. Choose it from measurements, and say why in architecture.md §14.
  - When the pane would push the column below it, the rail collapses to its icons first, and comes back when the pane closes. That’s #7’s recommendation, applied wherever it’s needed rather than at a fixed 1,440 px.
  - If the column is still too narrow, the pane’s view opens full screen instead, as `full=work` or `full=thread` does today, and Escape brings the conversation back.
  - What’s open stays in the address, so a wider window puts the pane back beside the conversation.
- **#86:** a handle on the pane’s left edge changes `--pane-w`:
  - by pointer, and by arrow keys, as a `role="separator"` with `aria-valuenow`, labeled
  - within a minimum of about 320 px, and a maximum that keeps the column’s minimum
  - double-click resets it
  - the width is kept like the divider’s place (`pb-pane-w`), as this browser’s convenience
  - app frames resize with it
- **#122:** an open thread is remembered per conversation, as Work is, and reopens when you come back.

## Files

- **Yours:** `app/js/pane.mjs`, the pane’s routing in `app/js/ui.mjs`, the pane and column rules in `app/workbench.css`, `tools/check-work-pane.mjs`’s layout cases, or a new `tools/check-pane-width.mjs`.
- **Shared:**
  - **`app/js/shell.mjs`:** the side-threads session changes `mountThreads`. Change only the rail’s collapse.
  - **`app/js/ui.mjs`:** the blocks session changes `announceStreaming`. Change only the routing.
  - **`tools/check-work-pane.mjs`:** the work-list session adds the list’s cases. Add yours as their own cases, or in a new check.

## Done when

- Each issue has a test that fails without its fix. A headless check opens Work and a thread at 800, 1024 and 1280 px, with the sidebar open. At each width it checks that the column and the composer’s text box are at or above the minimum, or that the view opened full screen. It runs clean with `--lag 300`, with axe clean on the handle.
- #86’s handle works by pointer and keyboard, and its width survives a reload.
- The UAT docs for the right pane say what changed (text only).
