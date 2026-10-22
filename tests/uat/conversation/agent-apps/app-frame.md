# Agent-written app

![Agent-written app](../../screenshots/agent-app.png)

**Where:** Inline in replies, full conversation width.

## Why it exists

Agents write software when it explains better than prose; it must run safely and look like part of Postbox.

## Expected functionality

- Runs sandboxed (opaque origin, no network) on the cool app stage, labeled “Agent-written app”.
- Checked at 375 and 1280 px before you see it; a failed check goes back to the agent once, then shows with a note.
- The check also measures legibility: SVG marks under 4 px, text under 9 px, dashes too fine to tell from solid lines, and an app that shows only an error or missing-data message. These are warnings: the app is shown “with notes for @agent”, and the agent is told in its lint turn.
- Version menu ([screenshot](../../screenshots/app-version-menu.png)) shows older versions read-only; Expand removes the height cap.
- A crash shows a card with Reload and Ask to fix ([screenshot](../../screenshots/app-crashed.png)).
- Saved state survives reloads; saving never reloads the frame.
- Works in the Claude desktop browser pane.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. In “Corpus explorer”, search, pick passages, send them; switch to v1 and back; Expand.
3. Reload the page and check the app restores its state.
4. For the legibility warnings, run `node tools/check-feedback.mjs`: it shows a chart too small to read, a readable one, and an app with only an error.

**Pass if:** The app works, versions switch, state restores, the frame doesn’t reload on its own, and only the unreadable apps get notes.

## Related

- [charts](charts.md)
- [narration player](narration-player.md)
