# Confirm block

![Confirm block](../../screenshots/confirm-block.png)

**Where:** Before destructive or costly agent actions.

## Why it exists

You must see exactly what will happen before agreeing.

## Expected functionality

- States the consequence; the confirm button says the action (“Remove 14 passages”), not “OK”.
- Answering locks the block.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. In “Catalog tour”, confirm or cancel.

**Pass if:** Your answer reaches the agent and the block locks.
