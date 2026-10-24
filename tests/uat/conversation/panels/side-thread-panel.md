# Side thread panel

![Side thread panel](../../screenshots/side-thread-panel.png)

**Where:** Right panel, from a side-thread link.

## Why it exists

Agent-to-agent exchanges stay out of your conversation but remain visible and joinable.

## Expected functionality

- Shows the exchange between two agents; typing there adds you to it.
- Its agents are the conversation’s own, one session each (#228). A wake for a busy one waits in this thread’s queue, never a fork: “@a’s message · waits for @b to finish”, with Send now and Remove, and no Edit. Stopping @b drops it, and @a is told at its next turn; Send now to @b keeps it. An agent that wakes a persona the conversation doesn’t have brings a card, “Add @x to this conversation?”: Add joins it and delivers the wake; Don’t add tells the agent.
- Under each message, “Send to conversation” posts it in the conversation as a shared card, “From the thread “@a ↔ @b” · @b”, and the message then says “Sent to the conversation”. The conversation’s agents read it at their next turn; no one is woken (#128).
- Ask an agent there to “post this in the main chat”, and it can: its bring_to_conversation tool posts a shared card in the conversation, marked “shared by @b in a turn you started”. Only a turn you started, with a message in a side or topic thread, can use it. Nothing else in the side thread reaches the conversation on its own (#128).
- Summarize back, in the panel’s head, opens a menu of the thread’s two agents, the one that started it first, “started this thread”. The agent you pick writes a short summary here, and it’s posted in the conversation as “Summary of the thread “@a ↔ @b” · @a”; the button reads “Summary requested…” until then, and one at a time. It wakes no one, even when the summary @-mentions the other agent or its agent tries wake_agent, and doesn’t count against the wake limit (#225). Picking an agent moves focus to the thread’s composer while the button waits.
- A failed turn shows its card here, with Retry, which answers the wake again (#151).
- A file dropped on the panel attaches to the panel’s composer, not the conversation’s ([composer](../composer/composer.md), step 4).

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. In “Corpus planning”, open the side-thread link.

3. Hover a reply in it and choose Send to conversation; then ask one of its agents to post a summary in the main chat.

**Pass if:** The exchange is readable and you can reply in it, the reply you sent shows in the conversation as yours to send, and the agent’s post shows there marked as shared by it.
4. Choose Summarize back in the side thread’s head, and pick the agent that started it.

**Pass if:** It writes a summary in the side thread, and the summary shows in the conversation, marked as from the side thread. No other agent starts a turn. `node tools/checks/side-summary.mjs` covers this step by keyboard.
