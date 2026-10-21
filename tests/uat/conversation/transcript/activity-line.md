# Activity line

![Activity line](../../screenshots/activity-line.png)

**Where:** Above an agent reply that used tools.

## Why it exists

Shows the work without flooding the transcript.

## Expected functionality

- Collapsed: “Used N tools · time”, or a single step’s label.
- Expanded: each step with its state (running, done, failed) and duration.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “Index the shelf” and expand the activity line.

**Pass if:** Steps, states and durations are listed.
