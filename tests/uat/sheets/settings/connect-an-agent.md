# Settings: Connect an agent

![Settings: Connect an agent](../../screenshots/settings-connection.png)

**Where:** Gear › Connect an agent.

## Why it exists

Shows how other agents reach Postbox’s UI tools.

## Expected functionality

- Shows the MCP endpoint and the backends available here.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open the tab and compare the backends with the server’s startup log.

**Pass if:** The list matches.
