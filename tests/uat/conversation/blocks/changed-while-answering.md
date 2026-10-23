# A block that changed while you were answering

**Where:** Any choice, form, confirm or review block that its agent updates while you’re answering it.

No screenshot yet: the reviewing session takes it with the next UAT screenshot pass.

## Why it exists

On 22 October 2026, an agent revised a review block three times while the person was answering it (#123). Each revision erased the answer the person had just given, and each approval reached the agent as the same “submit {approve}”, so it published revision 4 on an approval of an earlier revision. An approval must never land on text you didn’t see, and your answer must never vanish before its agent has read it.

## Expected functionality

- Your answer is for the revision you saw: the one on screen when the page first showed the block. If the agent changed the block since, Submit (or Send, Confirm, Cancel) is refused once, and nothing reaches the agent. This holds even when the new revision was already drawn when you pressed it, and it can happen before you’ve touched the block.
- A review then says “This draft changed while you were answering”, above the review bar. Its view switch reads “Changes since you looked” and “Current”, and the diff from the text you saw is shown, with added and removed lines marked.
- Your draft comments stay. Each one follows its line into the new text; one whose line changed or was removed moves to the next line and is tagged “Its line changed”. Your verdict stays too.
- A choice, form or confirm shows a plain notice instead (“This changed while you were answering…”), and keeps your picks and typed values. A pick whose option the new version dropped is cleared, and a field it added starts from its default.
- The notice is announced once by screen readers, and focus moves to it, beside the button you pressed, so pressing that button again by reflex doesn’t answer text you haven’t read. Tab goes on to the buttons.
- Submitting again answers the revision now on screen. If the agent changes it yet again first, that answer is refused too, with the notice announced again.
- When it goes through, the agent reads “The person acted in block “issue” (revision 2)”.
- An answer you give while the agent is still working waits until its turn ends. If the agent updates that block before then, its update is refused, and so is an outcome it reports on your answer: your answer stays on screen with nothing new under it, and the agent is told what you answered and to read it first.
- No color but the warning callout is used: the notice is not amber, and nothing in it appears only on hover.

## Steps to reproduce

1. Run `node tools/check-answers.mjs`. It starts its own Postbox and headless Chrome, and checks the review and choice cases above.
2. With a real agent (see the README’s real-agent setup), ask: “Show me a three-line draft as a review block, then run `sleep 40`, then update the block with a new line added above its first line.”
3. While it sleeps, comment on line 2 and choose Request changes, but don’t submit. After the update arrives, press Submit review.
4. Check the notice, the diff, and that your comment now sits on line 3: it moved down with its line, untagged, since the line itself didn’t change. Submit again.
5. Ask the agent the same again, and this time submit your review while it sleeps.

**Pass if:** In step 4 the first Submit is refused with the notice and diff, your comment and verdict are kept, focus is on the notice, and the second Submit sends revision 2. In step 5 your review stays on screen as answered, and the agent says its update was refused because you’d answered revision 1.
