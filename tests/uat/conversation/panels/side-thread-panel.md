# Side thread panel

![Side thread panel](../../screenshots/side-thread-panel.png)

**Where:** Right panel, from a side-thread link.

## Why it exists

Agent-to-agent exchanges stay out of your conversation but remain visible and joinable.

## Expected functionality

- Shows the exchange between two agents; typing there adds you to it.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. In “Corpus planning”, open the side-thread link.

**Pass if:** The exchange is readable and you can reply in it.
