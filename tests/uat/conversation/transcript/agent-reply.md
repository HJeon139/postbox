# Agent reply

![Agent reply](../../screenshots/agent-reply.png)

**Where:** Left-aligned in the transcript.

## Why it exists

The agent’s answer, streamed as it’s written, in Markdown.

## Expected functionality

- Speaker line: ring, @name, “mock” for a mock agent (#12), status word while it works, time. The ring shows the agent’s state now, in its color, but holds still: needing you is a steady outer ring, not a pulse. Only the live rings move, in the sidebar, the top bar and the working row, so a long conversation doesn’t keep the GPU busy. Only the ring beside the agent’s latest reply shows its state now, as the status word does; the rings beside its earlier replies rest idle, at the context they last showed, so a change in the agent’s state redraws one ring in the transcript, not one per reply (#622).
- One speaker line per turn: the items of one turn (text split by a block or a tool call) share it, and a later turn of the same agent gets its own, with its time. A turn another agent started says so: “woken by @critic”, or “after @researcher replied in a side thread”; one its own scheduled wake started says “woken by a scheduled wake” (#135). In a side thread, two messages an agent sent from two of its turns, before the other answered, have a speaker line each.
- Text streams with a caret; only the newest segment of a turn shows the caret.
- A screen reader hears the reply through the live region a sentence at a time, once each sentence is finished, as plain text: no code ticks, emphasis or heading marks, list bullets or link addresses, and no code blocks. A table is read a row at a time, as its cells, without its delimiter row. A dot inside a word (`converter.py`, `v0.13.0`, `6.21371`, “e.g.”) stays in its sentence, and nothing before it is lost (#196).
- Raw HTML is shown as text, never rendered; links open in a new tab with noopener.
- Bold and italic text can hold inline code: **Add three checks to `rename.py`:** is bold, with no asterisks showing (#82).
- The one exception: `<details><summary>Answer</summary> … </details>`, with no attributes, folds its Markdown away until you open it (agents use it to hide an exercise’s answer). It opens by click or by Enter on the summary, and folds can nest. A `<details>` with attributes, or one that’s never closed, stays text.
- **Reactions** (#251, #320, #418). Under each reply, block and app, beside “Reply in thread”, all five reactions are buttons, always shown: Good, Not good, Flag this, Unclear and Done. Clicking one adds yours, and clicking it again takes it back. Yours is highlighted (pressed); one only agents made shows a count of 1, so it’s visible without hover and remains distinct from yours. With more than one reactor, the count rises. Hovering one, or Tabbing to it, opens a card saying who reacted (“You and @critic”), and the button’s name says it too (“Good, from you and @critic: take yours back”). Enter or Space reacts, as on any button. Reacting doesn’t redraw the message, or an app’s frame.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Watch a reply stream in “Corpus explorer”.
3. Run Postbox with real agents (`node server/index.mjs --port 4181 --data /tmp/pb-uat-real --fresh`, with Claude Code installed and signed in) and open <http://127.0.0.1:4181/>. Ask an agent to reply with `<b>hi</b>` and a link, then ask @researcher to explain something step by step and end with an exercise whose answer is hidden. Ask for a numbered list of steps whose labels are bold and name a file in backticks.
4. Under a reply, click 👍, hover it, then Tab to 🚩 and press Enter. Ask the agent to react to your message with ✅, then add yours to the same message.

**Pass if:** Text streams smoothly, HTML stays text, links open in a new tab, the exercise’s answer is folded under “Answer”, with no tags showing, and bold labels with code in them show no asterisks. Your reactions are highlighted, an agent’s alone shows 1, the card names who reacted on hover and on focus, and a reaction two made shows 2. `npx playwright test reactions` passes.

## Related

- [activity line](activity-line.md)
- [citations](citations.md)
