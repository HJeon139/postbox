# Following the newest message

**Where:** The conversation’s transcript, and the topic or side thread in the panel beside it.

## Why it exists

In Dispatch mode you glance at a conversation to see what changed. That only works if the view stays on the newest message while agents work, and stays put while you read something older. (#88)

## Expected functionality

- **At the bottom, you stay at the bottom** through anything that changes the transcript: a reply streaming, an item updated in place (its activity, sources, a block answered), a working row coming or going, an app frame growing after it loads, the thread panel opening or closing, and a window resize. The panel’s own transcript does the same.
- **Scrolled up, nothing moves you.** Only your own scrolling up (wheel, trackpad, keys or dragging the scrollbar, even over an app) leaves the bottom. After that, new messages, streaming, an item or app above you growing, a resize, and opening or closing the panel all leave the message you’re reading where it is.
- Every browser behaves the same: the browser’s own scroll anchoring is off, and Postbox keeps the place itself.

## Steps to reproduce

1. Run `node tools/check-transcript.mjs`. It drives a long room with real wheel and mouse input: streaming, patches, an app growing from 200 to 700 px, the panel and a resize at the bottom; and the same changes scrolled up.
2. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays. In “Corpus explorer”, stay at the bottom while @librarian streams and its app loads.
3. Open a thread from an older message while scrolled up, then close it.

**Pass if:**
- At the bottom, the newest message never drifts out of view.
- Scrolled up, the message you’re reading doesn’t move, including when the panel opens or closes.

## Related

- [Working row](working-row.md)
- [Agent-written app](../agent-apps/app-frame.md)
- [Topic thread panel](../panels/topic-thread-panel.md)
