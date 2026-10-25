# Session card

![Session card](../screenshots/overview-card.png)

**Where:** The overview, for an agent that needs you or is working. An idle agent is in its conversation’s row instead.

## Why it exists

Everything about one agent at once, so you can decide without opening the conversation.

## Expected functionality

- Header: ring, @name (a link to its conversation), project and conversation on one line (a long name is cut short on screen, whole in the link), what it runs with, state line.
- What it runs with (#60): its backend, the model that answered its last turn (the one it’s set to before its first turn) and the effort, with full model ids: “Claude Code · claude-opus-5-5 · medium effort”. A model that isn’t the one set says “· not the model you set: claude-opus-5-5”. A mock agent says “Mock agent · scripted replies, not a model”, and “mock” after its @name (#12).
- Needs you: what it’s waiting on, with a quick answer for a simple choice or confirm, or Open conversation. The card has a heavier amber top edge and a tinted head band, unlike any button’s 1 px amber outline, so it stands out from the controls on it (#8).
- While it needs you, its ring is a button (“Go to what @handle needs”): it opens the ask’s thread, in the side panel for a side or topic thread, and scrolls the ask into view, focused and outlined for a moment (#285).
- Only a block from the agent’s latest turn makes it need you. Blocks you left open from earlier turns show quietly under the state line, as “1 open review”, and the agent stops reading “needs you” once you send it a new message or it finishes another turn (#69).
- Current step, last message, tool calls, agent messages (each opens its side thread), subagents, then context %, compactions and started along the bottom.
- A section with nothing in it isn’t shown, and the current step isn’t shown when the header already says it (“Waiting for you”, “Thinking”) (#3).
- Cards in a row are the same height, with their stats lined up along the bottom.
- Clicking anywhere on the card, outside its buttons, opens the conversation.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. On the overview, answer @researcher’s paper choice from the card.
3. Click an empty part of another card.
4. Click an agent message line.
5. Leave a block unanswered, and send its agent a new message.

**Pass if:** The quick answer reaches the agent, the card click opens the conversation, and the agent-message line opens the side thread. After step 5, the agent’s conversation is an idle row with “1 open …” in it, not a “Needs you” card. No card shows an empty section or “None”.

## Related

- [overview](overview.md)
