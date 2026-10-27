# Invalid block fallback

![Invalid block fallback](../../screenshots/invalid-block.png)

**Where:** Wherever an agent sends a block Postbox can’t show.

## Why it exists

A bad block must never break the transcript or fail silently. Since #455 (decided by the person on 27 October 2026), it also never reaches the person as a broken card: the agent hears why in the same call, and fixes it first.

## Expected functionality

- **A new invalid block isn’t shown.** `show_block` returns its problems in the same call, on this computer and on a remote host alike, and nothing appears in the conversation until the agent sends a valid one. Options written as plain strings get one error that shows the `{ id, label }` shape.
- **A block stored before #455, or an app,** shows the agent’s plain-text fallback, “Can’t show this block”, and a collapsed Show the raw block with the reason.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “Index the shelf” after scene 8, where @indexer is asked to show its chapters as a timeline.

**Pass if:** No “Can’t show this block” card appears for @indexer’s three blocks, and its reply says Postbox couldn’t show them and gives each one’s plain-text version.
