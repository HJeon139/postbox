# Confirm block

![Confirm block](../../screenshots/confirm-block.png)

**Where:** Before destructive or costly agent actions.

## Why it exists

You must see exactly what will happen before agreeing.

## Expected functionality

- States the consequence; the confirm button says the action (“Remove 14 passages”), not “OK”.
- Answering locks the block.
- When the agent reports what it did (“Done: 23 frames deleted”), the result shows as a line under your answer, in Markdown. The block stays answered, with no button to press again, and the agent doesn’t need you. The question stays as you answered it. Only an update without a result asks again.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. In “Catalog tour”, confirm or cancel.
3. Run `node tools/check-contract.mjs`: it confirms a block, has the agent report the result, and checks the line under the answer, the locked block and that nobody is asked again.

**Pass if:** Your answer reaches the agent and the block locks, and a reported result shows under your answer without reopening it.
