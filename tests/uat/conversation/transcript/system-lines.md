# System lines

![System lines](../../screenshots/system-wake-line.png)

**Where:** Between messages.

## Why it exists

You can always see who started what: wakes, joins, compactions, side threads, attachments of terminal sessions.

## Expected functionality

- “You woke @x”, “@a woke @b · agent wake n of 3”.
- Compaction divider with Show summary ([screenshot](../../screenshots/compaction-divider.png)).
- A side-thread link “@a asked @b · n messages · Open” ([screenshot](../../screenshots/side-thread-link.png)).

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “Corpus planning”; expand the compaction summary; open the side-thread link.

**Pass if:** Each line is present and its control works.
