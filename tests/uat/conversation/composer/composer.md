# Composer

![Composer](../../screenshots/composer.png)

**Where:** Bottom of a conversation.

## Why it exists

Where you write to agents; it must say who will answer.

## Expected functionality

- Enter sends, Shift+Enter adds a line; drafts are kept per conversation.
- The hint says who replies (the last speaker in a room); Stop replaces Send while an agent works.
- Messages sent while an agent is busy are queued with Send now, Edit and remove ([screenshot](../../screenshots/queued-message.png)).
- Messages typed offline are sent when the connection returns.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. In “Corpus planning”, send while @indexer works; use Send now on the queued message.

**Pass if:** The queued message is delivered when @indexer finishes, or at once with Send now.

## Related

- [plus menu](plus-menu.md)
- [mention menu](mention-menu.md)
