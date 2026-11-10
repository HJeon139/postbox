# A block that changed while you were answering

**Where:** Any choice, form, confirm or review block that its agent updates while you’re answering it.

No screenshot yet: the reviewing session takes it with the next UAT screenshot pass.

## Why it exists

On 22 October 2026, an agent revised a review block three times while the person was answering it (#123). Each revision erased the answer the person had just given, and each approval reached the agent as the same “submit {approve}”, so it published revision 4 on an approval of an earlier revision. An approval must never land on text you didn’t see, and your answer must never vanish before its agent has read it.

## Expected functionality

- Your answer is for the revision on screen. When the agent changes a block you haven’t answered, the page draws the new version at once, with a notice under the block’s buttons (“The agent changed this since you first saw it…”). No click is needed to see it, the notice never takes focus, and it never moves a button under the pointer. Your next Submit (or Send, Confirm, Cancel) answers the version on screen (changed 10 November 2026: the first click used to be refused just to show the notice).
- A review’s notice says Lines marks what changed. In Lines, its view switch reads “Changes since you looked” and “Current”, and the diff runs from the first version you saw, however many revisions came since, with added and removed lines marked. Preview stays Preview: the change doesn’t switch your view.
- Your draft comments stay. Each one follows its line into the new text; one whose line changed or was removed moves to the next line and is tagged “Its line changed”. Your verdict stays too.
- A choice, form or confirm keeps your picks and typed values. A pick whose option the new version dropped is cleared, and a field it added starts from its default.
- An answer for a revision the page hasn’t drawn yet (the update is still on its way) is refused, says so, and nothing reaches the agent; the new version and its notice replace the error when they arrive.
- When it goes through, the agent reads “The person acted in block “issue” (revision 2)”.
- An answer you give while the agent is still working waits until its turn ends. If the agent updates that block before then, its update is refused, and so is an outcome it reports on your answer: your answer stays on screen with nothing new under it, and the agent is told what you answered and to read it first.
- The notice is a plain callout, not amber, and nothing in it appears only on hover.

## Steps to reproduce

1. Run `npx playwright test answers` (`tests/browser/answers.spec.mjs`). It checks the review and choice cases above.
2. With a real agent (see the README’s real-agent setup), ask: “Show me a three-line draft as a review block, then run `sleep 40`, then update the block with a new line added above its first line.”
3. While it sleeps, comment on line 2 and choose Request changes, but don’t submit. Watch the update arrive.
4. Check, before any click, the notice, the diff, and that your comment now sits on line 3: it moved down with its line, untagged, since the line itself didn’t change. Submit once.
5. Ask the agent the same again, and this time submit your review while it sleeps.

**Pass if:** In step 4 the notice and the diff appear without a click, focus doesn’t jump to the notice, your comment and verdict are kept, and the one Submit sends revision 2. In step 5 your review stays on screen as answered, and the agent says its update was refused because you’d answered revision 1.
