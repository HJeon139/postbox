# Wake-limit confirm

![Wake-limit confirm](../../screenshots/hop-confirm.png)

**Where:** Only on a card stored before #492, which removed the wake limits: until then, after ten agent-to-agent wakes in a row (three until #320). A new wake raises no such card; the composer counts the chain instead (#492).

## Why it exists

Stops two agents from looping on each other.

## Expected functionality

- Says which agent wants to wake which and why; allow or decline.
- Only one waits at a time.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Scene 7 in “Corpus planning”: allow the eleventh wake.

**Pass if:** The wake happens only after you allow it.
