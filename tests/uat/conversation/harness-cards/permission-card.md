# Permission card

![Permission card](../../screenshots/permission-card.png)

**Where:** In the conversation, when an agent asks before a risky tool call.

## Why it exists

In ask mode (and when auto mode can’t decide) you approve exactly what will run.

## Expected functionality

- Shows the exact command or file, wrapped so it’s fully visible, with Allow and Don’t allow.
- The agent needs you until you answer; Stop answers no and marks the card expired.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Scene 10 (“Clear the index cache”): answer Allow.
3. Run Postbox with real agents (`node server/index.mjs --port 4181 --data /tmp/pb-uat-real --fresh`, with Claude Code installed and signed in) and open <http://127.0.0.1:4181/>. Set an agent to Ask me, ask it to run `ls`, and deny.

**Pass if:** Allow lets the command run; Don’t allow makes the agent carry on without it.
