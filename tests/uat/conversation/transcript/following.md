# Following the newest message

**Where:** The conversation’s transcript, and the topic or side thread in the panel beside it.

## Why it exists

In Dispatch mode you glance at a conversation to see what changed. That only works if the view stays on the newest message while agents work, and stays put while you read something older. “Jump to latest” has to be honest too: a count of new messages when nothing is unread below teaches you to ignore it (#88, #91).

## Expected functionality

- **At the bottom, you stay at the bottom** through anything that changes the transcript: a reply streaming, an item updated in place (its activity, sources, a block answered), a working row coming or going, an app frame growing after it loads, the thread panel opening or closing, and a window resize. The panel’s own transcript does the same.
- **Typing doesn’t push the newest message away.** At the bottom, in the conversation or the thread panel, a draft that grows to several lines keeps the newest message above the composer, and the reply you’re waiting for is still followed, whether you keep the draft or send it and the composer shrinks back (#422, #360).
- **Scrolled up, nothing moves you.** Only your own scrolling up (wheel, trackpad, keys or dragging the scrollbar, even over an app) leaves the bottom. After that, new messages, streaming, an item or app above you growing, a resize, and opening or closing the panel all leave the message you’re reading where it is.
- **Jump to latest · N new** appears only while you’re scrolled up and new messages arrive below. It counts them, including one that arrives in the very moment you scroll up (#341), and it goes, with its count, as soon as you reach the bottom by any means: the pill, the wheel, End, or dragging.
- The pill floats just above the composer and takes no room, so showing or hiding it never moves the page. It shows only while the end is further below than the pill’s own height, so it never sits over the working rows or the end of the last message.
- **A card at the bottom stays still.** When what follows the newest message shrinks (a working row going away, a card getting shorter once answered, the composer), the transcript keeps its height instead of pulling everything down, so a button you’re about to click doesn’t slide out from under the pointer. The space fills with the next message, or goes when the window’s width changes.
- Every browser behaves the same: the browser’s own scroll anchoring is off, and Postbox keeps the place itself.

## Steps to reproduce

1. Run `npx playwright test transcript composer-grow scroll-frame` (`tests/browser/transcript.spec.mjs`, `composer-grow.spec.mjs` and `scroll-frame.spec.mjs`). The transcript spec drives a long room with real wheel and mouse input: streaming, patches, an app growing from 200 to 700 px, the panel and a resize at the bottom; the same changes scrolled up; and the pill. composer-grow types a six-line draft with the keyboard, at 1280 and 375 px and in the thread panel, kept or sent. scroll-frame scrolls up and hands the page a reply in the same moment, which a real reply does only now and then.
2. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays. In “Corpus explorer”, stay at the bottom while @librarian streams and its app loads.
3. Scroll up a little while an agent works, wait for two messages, then scroll back down with the wheel.
4. Open a thread from an older message while scrolled up, then close it.
5. At the bottom, type a six-line draft with Shift+Enter while an agent replies, then send it.

**Pass if:**
- At the bottom, the newest message never drifts out of view, and a card’s buttons don’t move when the working row below it goes away.
- Scrolled up, the message you’re reading doesn’t move, including when the panel opens or closes.
- The pill shows the right count, and disappears the moment you reach the bottom without clicking it.
- With the draft growing and after sending it, the newest message and the agent’s reply stay above the composer.

## Related

- [Working row](working-row.md)
- [Agent-written app](../agent-apps/app-frame.md)
- [Topic thread panel](../panels/topic-thread-panel.md)
