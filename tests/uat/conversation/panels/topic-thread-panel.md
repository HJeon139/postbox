# Topic thread panel

![Topic thread panel](../../screenshots/topic-thread-panel.png)

**Where:** Right panel, from Reply in thread.

## Why it exists

Follow a side question without filling the main agent’s memory: the thread’s agent is a fork of its session at that message.

## Expected functionality

- Shows the root message (clamped, Show all), what the forked agent remembers, the replies, and a composer.
- Under its header, “Agents in this thread” lists the thread’s agents, with the same rows and [quick panel](../../shell/rail/agents-section.md) as the sidebar’s (#105). The thread’s composer has no `/` commands, so this is where its agents’ model, effort, mode and tools change. Model and effort set here are the thread’s own: the conversation’s session keeps its own.
- Summarize back posts a summary to the conversation; Send to conversation posts one reply.
- One summary at a time (#93): from the click until the summary is posted, the button reads “Summary requested…” and is disabled, in every tab, and the server refuses a second request. If the turn fails or is stopped, the button comes back.
- Once the summary is posted, the reply it came from shows “Sent to the conversation”, with no Send button, so it can’t go twice. While the summary is still being written, its replies can’t be sent on their own.
- An agent you @-mention into the thread that isn’t a fork (it wasn’t in the conversation, or joined after the message) starts with the message the thread is about: its text, or a block’s or app’s title and text version. A fork already remembers it and isn’t told again (#81).
- Close returns to the conversation; on a phone it’s full screen.
- A file dropped on the panel attaches to the panel’s composer, not the conversation’s ([composer](../composer/composer.md), step 4).

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Reply in thread under an agent reply, ask a question, Summarize back.
3. Run `node tools/check-transcript.mjs`: it double-clicks Summarize back, asks again from a second “tab”, and checks one summary and the reply marked sent.
4. Run Postbox with real agents (`node server/index.mjs --port 4181 --data /tmp/pb-uat-real --fresh`, with Claude Code installed and signed in) and open <http://127.0.0.1:4181/>. Branch from an earlier message and ask about something said after it; the fork shouldn’t know it. Then open a thread on a table and @-mention an agent that isn’t in the conversation, asking it to check one row.

**Pass if:** The summary appears in the conversation once, the reply shows it was sent, the fork remembers only up to its root, and the agent brought in fresh can quote the row without you pasting it.

## Related

- [message actions](../transcript/message-actions.md)
