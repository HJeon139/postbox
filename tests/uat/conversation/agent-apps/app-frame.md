# Agent-written app

![Agent-written app](../../screenshots/agent-app.png)

**Where:** Inline in replies, full conversation width.

## Why it exists

Agents write software when it explains better than prose; it must run safely and look like part of Postbox.

## Expected functionality

- Runs sandboxed (opaque origin, no network) on the cool app stage, labeled “Agent-written app”.
- Checked at 375 and 1280 px before you see it; a failed check goes back to the agent once, then shows with a note.
- Version menu ([screenshot](../../screenshots/app-version-menu.png)) shows older versions read-only; Expand removes the height cap.
- A crash shows a card with Reload and Ask to fix ([screenshot](../../screenshots/app-crashed.png)).
- Saved state survives reloads; saving never reloads the frame.
- An app’s `postbox.send` (a line in your voice, and an agent turn) counts only right after you click or press a key in that app. A send on load or on a timer is refused, and the app gets the reason. Up to 5 a minute go straight through; more wait on the [app send card](../harness-cards/app-send-card.md).
- An app gets the keyboard only when you click it or Tab into it. An app that moves focus into itself gives it straight back (your typing stays in the composer) and can’t send until you click or Tab into it; one that keeps doing it is stopped, with a card to reload it. An app takes clicks once Postbox sees the pointer over it: when the pointer moves onto it, or when the app moves under a resting pointer (scrolling, a reply streaming in, a message landing above). An app that moves away from the pointer stops taking clicks. Known limit: a click whose press lands in the same instant the pointer arrives, with no rest in between, goes to the page and has to be repeated. Hands always rest for a moment; automated clicks, including the Claude desktop browser pane’s, may not.
- Works in the Claude desktop browser pane.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. In “Corpus explorer”, search, pick passages, send them; switch to v1 and back; Expand.
3. Reload the page and check the app restores its state.
4. Run `node tools/checks/app-send.mjs`: an app that sends on load is refused, a click or Enter in it sends, and a frame that grabs focus can’t send.

**Pass if:** The app works, versions switch, state restores, the frame doesn’t reload on its own, and no line appears in your voice that you didn’t click or type for.

## Related

- [charts](charts.md)
- [narration player](narration-player.md)
- [app send card](../harness-cards/app-send-card.md)
