# The front end: plain HTML, CSS and ES modules, no build

Part of [the architecture](../architecture.md). The page: plain HTML, CSS and ES modules, with no framework and no build, and the right pane beside a conversation.

**Decision.** Keep the shipped app framework-free with no build step, and add type checking and linting as development-only tools, so the app itself still needs nothing but Node to run.

**Does it make Postbox faster for you?** At load, yes:
- **First load.** The app is plain ES modules (156 in `app/js/`, about 940 KB uncompressed, on 12 November 2026) plus one stylesheet, served with gzip and ETags, so a reload revalidates cheaply (`server/served-files.mjs`). There’s no framework runtime, no hydration and nothing to download before the first paint, and a full reload of a long thread renders in well under a second locally.
- **While you use it.** The hot paths are re-rendering Markdown while a reply streams (batched once per frame) and big tables. Neither depends on a framework.
- **The costs are ours, not yours.** We hand-write list reconciliation (`syncList`) and event wiring, which is where Stage 2’s bugs were. There are no compile-time types. Contributors used to a framework need a moment to adjust.

**What keeps it fast**
- Static files carry gzip and an ETag, as above.
- Every module is small enough to read in one sitting ([code-size.md](code-size.md)).
- Not built yet: virtualizing table rows above about 1,000.

## The transcript window

A page doesn’t hold every item of every conversation ([#508](https://github.com/HJeon139/postbox/issues/508)). A long conversation mounts only the items around where you are, with spacers standing in for the rest at about their height, and unmounts what’s furthest from the view past a ceiling of items or a budget of elements (`app/js/window.mjs`, #866, #1155). The page loads a conversation’s items by range as it draws them, rather than every item with `/api/state` (`server/items-routes.mjs`, #1155). An explicit view state, following the newest item or reading at an anchor, is changed only by the person’s input and re-applied after every change to the DOM (`app/js/view-state.mjs`; `designs/508/b1-view-state.md`). Still no framework and no build step. Detail: `designs/508/design.md`, “Browser”, and `designs/508/712a-skipped-items.md`.

**Revisit when** the UI gains shared editing or several people, or the hand-written reconciliation grows past what one file can hold. The first step then would be a small runtime library such as Preact with `htm`, which still needs no build step, rather than a full build pipeline.

## The right pane

A thread and the Work view ([work-ledger.md](work-ledger.md)) are the conversation’s side views in the right pane ([`app/js/pane.mjs`](../../app/js/pane.mjs)), beside one another or alone, not pages of their own. What’s open is in the address after the conversation’s path, so a reload restores it and the views change in place without rebuilding the transcript:

```mermaid
flowchart LR
  A["#/t/conv/side/thread?work&turn=t1&full=work&at=item"] --> R[route]
  R -->|sideId| T[thread view]
  R -->|work, turn| W["Work view: compact form (mountWorkPane)"]
  R -->|"full=work, at"| F["Work’s full form (mountWork), in its place"]
  R -->|full=thread| TF["the same thread, fixed over the window"]
  T & W --> P["pane: one view, or split by a divider"]
```

- `work` opens the compact form, `turn` scrolls it to a turn’s line (or, full screen, shows that turn alone), `full=work` or `full=thread` shows that view full screen, and `at` opens one item in full-screen Work.
- **One contract for a pane view:** a compact form in the pane and a full form over the window, with the app frames’ full-screen icon (#45) in its head. Full screen doesn’t move or rebuild the view: pane.mjs fixes the view’s own element over the window (`pane-full`), makes it a modal dialog while it lasts (Tab stays in it; Escape or the icon ends it, with focus back on what opened it: the icon, or the item chosen in the pane), and Work swaps its body for `mountWork`. So a thread keeps its composer draft, its scroll (#88’s anchor holds through the width change) and a streaming reply. App frames keep their own full screen (#45). 
- Opening and closing Work replaces the address instead of adding to the history, and the browser remembers per conversation that Work was left open (`pb-work-<id>` in `localStorage`), so a link to the conversation or one of its threads opens it beside them again, in a window with room for both (below that, the conversation opens on its own: “Room for the conversation”, below). A thread left open is remembered the same way (`pb-side-<id>`, #122), in [`app/js/pane-route.mjs`](../../app/js/pane-route.mjs): coming back from another conversation opens it again, while it’s still there, and closing it while you stay in the conversation forgets it. The divider’s place is kept the same way (`pb-pane-split`). All four (`pb-work-<id>`, `pb-side-<id>`, `pb-pane-split` and `pb-pane-w`) are this browser’s conveniences, not state anyone else needs.
- The pane’s width is `--pane-w`, which `pane-width.mjs` sets. A handle on the pane’s left edge changes it (#86): a separator that ← and → move by 16 px, Home and End take to the pane’s minimum and to the most the column’s minimum allows, a drag moves, and a double-click puts back at 440 px. Its width is kept like the divider’s place (`pb-pane-w`), and app frames, as wide as the transcript, resize with it.
### Room for the conversation

From #197. Beside the pane, the conversation column (`.main`, with its padding) never gets narrower than 640 px (`COL_MIN` in [`app/js/pane-width.mjs`](../../app/js/pane-width.mjs)). Measured on 23 October 2026 in Chrome with the demo seed: the composer’s text box is the column less 207 px, and a reply’s text the column less 48 px. #197 found a 129 px text box (a 336 px column) unusable. At 640 px the text box is 433 px, about 60 characters, a reply’s text 592 px, and the composer’s hints take three lines (four below a 520 px column). To keep the column, the rail hides first (#7), for as long as the pane is open (`rail-auto`, which leaves the person’s own choice, `pb-rail`, as it was); ⌘\ shows it again for that while. So at 1280 px an app beside a thread gets 792 px, where #7 measured about 590 px with the rail open; the rail hides wherever the pane needs its room, below 1,328 px with the pane at 440 px, rather than at #7’s fixed 1,440 px. Where the pane’s minimum doesn’t fit beside the rail (below 1,208 px), the rail stays hidden, and its button says why rather than pushing the pane full screen over it. Then the pane gives up width, down to its own minimum of 320 px. Every width here is the page’s, without a classic scroll bar (`document.documentElement.clientWidth`), which Windows, Linux and some macOS settings take from the window. Where even that doesn’t fit, the pane’s view opens full screen instead (the view opened last, as `full=` shows it), while the address still says only what’s open, so a wider window puts the pane back beside the conversation. Escape there brings the conversation back by closing what’s open, since there’s no pane to go back to. Below 768 px the pane covers the conversation.
