# Rail row

![Rail row](../../screenshots/rail-row.png)

**Where:** Each conversation in the rail.

## Why it exists

One glance tells you who is in a conversation and what they are doing.

## Expected functionality

- Shows the agent ring(s), the conversation’s name, @handles and the most urgent status word on one line.
- A mock agent says “mock” after its @handle, in a room too (“@librarian mock, @indexer”). Moving its persona to Claude Code drops the marker without a reload (#12).
- An unread badge appears when an agent finishes while you’re elsewhere.
- The open conversation is marked (aria-current).
- While one of its agents needs you, the row goes to that agent’s ask instead of only opening the conversation: it opens the ask’s thread (the side panel for a side or topic thread), scrolls the ask into view, focuses its first control and outlines it for a moment (#285). In a room, clicking a ring in the stack goes to that agent’s ask; anywhere else on the row goes to the agent that has waited longest. With nothing waiting, the row opens the conversation as before.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Watch the “Corpus planning” row while @indexer works in it.
3. Leave the conversation and let an agent finish; check the unread badge.
4. Get two agents in a room to ask you something, then open another conversation. Click one agent’s ring in the room’s row, then come back and click the row’s name.

**Pass if:** The ring and status word follow the agent’s state, and the badge clears when you open the conversation. In step 4, the ring lands on that agent’s ask and the name on the one that asked first, each focused and outlined. `npx playwright test needs-nav` passes.

## Related

- [rail](rail.md)
