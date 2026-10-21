# Agent reply

![Agent reply](../../screenshots/agent-reply.png)

**Where:** Left-aligned in the transcript.

## Why it exists

The agent’s answer, streamed as it’s written, in Markdown.

## Expected functionality

- Speaker line: ring, @name, status word while it works, time.
- Text streams with a caret; only the newest segment of a turn shows the caret.
- Raw HTML is shown as text, never rendered; links open in a new tab with noopener.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Watch a reply stream in “Corpus explorer”.
3. Run Postbox with real agents (`node server/index.mjs --port 4181 --data /tmp/pb-uat-real --fresh`, with Claude Code installed and signed in) and open <http://127.0.0.1:4181/>. Ask an agent to reply with `<b>hi</b>` and a link.

**Pass if:** Text streams smoothly, HTML stays text, and links open in a new tab.

## Related

- [activity line](activity-line.md)
- [citations](citations.md)
