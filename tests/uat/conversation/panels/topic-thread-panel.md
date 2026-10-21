# Topic thread panel

![Topic thread panel](../../screenshots/topic-thread-panel.png)

**Where:** Right panel, from Reply in thread.

## Why it exists

Follow a side question without filling the main agent’s memory: the thread’s agent is a fork of its session at that message.

## Expected functionality

- Shows the root message (clamped, Show all), what the forked agent remembers, the replies, and a composer.
- Summarize back posts a summary to the conversation; Send to conversation posts one reply.
- Close returns to the conversation; on a phone it’s full screen.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Reply in thread under an agent reply, ask a question, Summarize back.
3. Run Postbox with real agents (`node server/index.mjs --port 4181 --data /tmp/pb-uat-real --fresh`, with Claude Code installed and signed in) and open <http://127.0.0.1:4181/>. Branch from an earlier message and ask about something said after it; the fork shouldn’t know it.

**Pass if:** The summary appears in the conversation, and the fork remembers only up to its root.

## Related

- [message actions](../transcript/message-actions.md)
