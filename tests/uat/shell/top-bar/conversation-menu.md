# Conversation menu

![Conversation menu](../../screenshots/conversation-menu.png)

**Where:** Top bar, “⋯” beside the agent chips, in a conversation.

## Why it exists

Conversations need to be renamed, grown into rooms and deleted without leaving the conversation.

## Expected functionality

- Rename… opens the [rename sheet](../../sheets/rename.md).
- Add an agent… opens the [new-agent sheet](../../sheets/new-agent.md) joined to this conversation; a direct message becomes a room.
- Delete conversation… (or Delete room…) opens the [delete confirm](../../sheets/delete-conversation.md).

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “Corpus explorer”, open ⋯, and try each item, cancelling each sheet.

**Pass if:** Each item opens the right sheet, and Cancel leaves everything unchanged.

## Related

- [top bar](top-bar.md)
