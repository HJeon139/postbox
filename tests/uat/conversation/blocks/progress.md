# Progress block

![Progress block](../../screenshots/progress-block.png)

**Where:** Long jobs.

## Why it exists

Shows where a long job is without new messages.

## Expected functionality

- Steps with pending, running, done and failed states, detail and duration; updated in place as the agent moves on.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Watch “Index the shelf” in “Corpus planning”.

**Pass if:** Steps update in place; no copies are added.
