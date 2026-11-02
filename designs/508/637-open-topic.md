# #637: an agent opens a topic thread, and a thread's catch-up keeps the ask

| | |
|---|---|
| **Status** | Revision 1, approved by the person on 2 November 2026; critic's read and engineer's peer read (rule 13) before code |
| **Issues** | #637 (the tool), #507 (the thread catch-up), both on `main` at `d2b5c21d` |

## What changes

1. **A tool, `open_topic { itemId, message?, mentions? }`**, local (`toolsFor`) and on a host (`server/remote/turns-tools.mjs`), in a new `server/topic-open.mjs`. It calls the page's own `startTopic(conversationId, itemId)`, then posts the first message through `agentWake`'s path with `replyIn: topicId`: one message, shared by every mention, as a turn's later mentions already reuse it (`itemId`). With no mentions, the message is posted as the agent's, and it wakes no one. The reply names the thread's id, says it's open in the page beside the message, and says `read_conversation { thread }` reads it.
2. **#507:** `threadCatchUp` keeps its lines with the main catch-up's `keepFor` (mentions of the agent first, whole, under their own cap, then the newest of the rest), and says what it left out and where `read_conversation` finds it, as `leftOut` does. `keepFor` and `leftOut` are exported from `server/catch-up.mjs`, not copied.

No new event type, state key or field. `startTopic`, `putThread`, `addItem`, `agentWake` and `deliverWake` are the path the page and `wake_agent` use today, which is the path A1b and A2 turn into records and deliveries.

## Invariants

| | Rule | Held by |
|---|---|---|
| I1 | **One topic per root item.** A second open of the same item, by anyone, returns the first topic. | `startTopic`'s `root.topicId` check. It reads `store.pending` now (#601: its result decides a write), so a second open while the first's patch is held behind a commit finds it. That also fixes the page's own path. |
| I2 | **A topic never starts from a topic or side thread.** | `startTopic`'s 409, unchanged. |
| I3 | **The item is in the agent's own conversation.** The tool looks the item up only in `lineage(se.threadId).at(-1)`, the conversation, never a thread id the agent names. | the tool: an item of one of that conversation's topic threads gets I2's 409 (“reply in this one instead”); an id from anywhere else is 404, as for a missing item |
| I4 | **The opener answers there first.** When an agent opens the topic, the thread's `woke` is the opener, so a message the person writes there with no mention goes to it. | the tool sets `woke` after `startTopic`, only when it made the topic |
| I5 | **One write gate.** A call while the store is closed changes nothing. | `storeClosedTo` in `server/mcp.mjs`, which refuses every tool not in `READ_TOOLS` during ST-3; `open_topic` isn't a read |
| I6 | **One first message per open.** A call repeated after its answer was lost doesn't post its message twice. | the tool posts nothing when the topic already existed and the opener's newest message there has the same text |

## Failure table

| Case | What happens | The person sees |
|---|---|---|
| The store is closed | refused by the gate; nothing written | the agent's reply says why |
| Two agents open the same item | JavaScript runs each call whole, so the second finds the first's `topicId` (I1), through `store.pending` even while a commit is held. Its message, if any, goes into the first topic | one thread, with both messages |
| The item was deleted, or is in a topic or side thread | 404 or 409 before any write | the agent's reply says so |
| A remote turn loses its link mid-call | **Checked:** a call sent again after a reconnect gets the broker's kept answer (`answerKnown` in `broker-tools.mjs`), so it runs once. After a daemon restart that lost the answer, the agent is told to call again. The second call finds the topic (I1) and posts no second copy of its message (I6) | one thread, one message |
| A reader looks between the topic's creation and its first message | Every write is in one synchronous call, so no turn reads in between. The page can draw the thread's link one event before the message | the link, then the message |
| A mentioned agent is busy, archived or not in the conversation | `agentWake`'s rules: queued, refused, or a card asks you to add it | as for `wake_agent` |

## What A1b and A2 change later

- **A1b:** the first message becomes a record, the same way every agent message does. The tool keeps calling the same functions, so nothing about it migrates.
- **A2:** the wake becomes a delivery, as `wake_agent`'s does. A2's step gains one line saying the open's wake is a delivery like any other.
- **The design gains:** requirement MD-9 ("an agent can open a topic thread from any message in its conversation, locally and on a host, and the first message reaches whom MD-6 says"), with its acceptance row, and one line in `design.md`'s "Who a message reaches". Room rule 20 drops "from when #507 merges".

## Specs, failing first on `main`

1. `open_topic` opens a topic from an agent's message and from the person's, and a second call returns the same thread.
2. It refuses an item in a topic thread (409), an item from another conversation (404), and any call while the store is closed.
3. A mention in the first message wakes that agent in the thread, and its reply posts there. Two mentions share one message.
4. The same on a host's turn, through `turns-tools.mjs`.
5. Two opens of one item while a commit is held give one topic (I1 through `store.pending`).
6. #507: a 25-item thread whose ask, which mentions the agent, is its first message still shows the ask in the agent's catch-up, whole. The catch-up says how many items it left out.
7. A repeated call with the same message, after the topic exists, posts nothing new (I6).
8. A UAT trigger in `tests/uat/e2e/scenarios/delivery.md`: an agent opens a thread from a message, and the agent it asks answers there.

## Size

`server/runtime.mjs` is at its ceiling, so the tool's body goes in `server/topic-open.mjs`, and `toolsFor` gets a one-line binding, after a move out of `runtime.mjs` in its own commit if the binding would push it over. `catch-up.mjs` (113 lines) and `thread-summary.mjs` (267) stay under 300.
