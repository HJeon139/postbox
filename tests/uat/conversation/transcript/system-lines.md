# System lines

![System lines](../../screenshots/system-wake-line.png)

**Where:** Between messages.

## Why it exists

You can always see who started what: wakes, joins, compactions, side threads, attachments of terminal sessions.

## Expected functionality

- A scheduled wake: “@a will wake itself at 14:30”, with Cancel, then “@a woke itself, as scheduled”. If its turn hits a network failure before a tool starts, the same schedule returns to pending with bounded backoff. If a tool started, its next turn names those tools and says to check their effects before continuing. Other failures stay failed (#458, #466). A `/command` you run in a room: “You woke @x”.
- No line for a wake you or an agent made with an @-mention (#114): your message’s mention is the record of yours, and the side-thread link below counts the agents’ wakes, in place. A wake past the limit is its card, with your answer under it.
- Compaction divider with Show summary ([screenshot](../../screenshots/compaction-divider.png)).
- A side-thread link “@a asked @b · n messages · Open” ([screenshot](../../screenshots/side-thread-link.png)). While an agent works or waits for you in it, the link carries that agent’s ring and state: “@a asked @b · @b is calling tools · 3 messages · Open”, or “@b needs you” (#121). The agents’ catch-up shows the line with a summary of a few words once the thread settles (#228). The count is every message there, from you or an agent, one per agent turn, and it updates as they come (#130), however many times the two wake each other: one line per side thread (#114). When a turn there failed, the link reads “@b failed” and has Retry beside it, and Open goes to the failed card in the side thread (#151).

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “Corpus planning”; expand the compaction summary; open the side-thread link.

**Pass if:** Each line is present and its control works.
