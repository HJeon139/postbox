# Wake chain limit

**Where:** Conversation menu › Wake chain limit…, beside Rename…, in a conversation or a room.

## Why it exists

After a chain of agent wakes without your message, the next waits for your Allow: a backstop against agents that never stop. A working room can run past any one number in an afternoon of hand-offs, and one held wake stalls every agent in the room until you answer, so each room sets its own (#1035).

## Expected functionality

- The menu item says the room’s limit, “1,000 wakes in a row, the default”, or the room’s own number.
- The dialog has one number field, “Agent wakes in a row”, with the server’s default as its placeholder (1,000 unless `POSTBOX_CHAIN_LIMIT` sets another) and the room’s own number in it, if it has one.
- Save, or Enter in the field, saves a whole number from 1 to 10,000. Empty saves the default.
- Anything else (0, 2.5, 10,001) shows “A room’s wake chain limit is a whole number from 1 to 10,000.” under the field, and the dialog stays open with what you typed.
- “Use the default” clears the room’s own number.
- The composer’s hint names the room’s limit (“…since your last message, of the room’s limit of 5.”), and a wake card says the limit it was raised under (“past the limit of 5”).
- From a topic thread it sets its conversation’s limit.
- By keyboard alone: Enter on ⋯, ArrowDown to the item, Enter; focus returns to ⋯ when the dialog closes.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “Index planning”, open ⋯ › Wake chain limit…, type 0 and press Enter, then type 5 and press Enter.
3. Open it again and choose “Use the default”.

**Pass if:** 0 is refused under the field with the dialog still open; 5 closes the dialog and the menu item then says “5 wakes in a row”; “Use the default” brings back “1,000 wakes in a row, the default”. Focus is on ⋯ after each close.

## Related

- [conversation menu](../shell/top-bar/conversation-menu.md)
- [wake-limit confirm](../conversation/harness-cards/hop-confirm.md)
