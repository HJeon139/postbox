# The room’s Manage button

**Where:** Top bar, the gear after the conversation’s title, in a conversation. It took the place of the “⋯” conversation menu on 26 November 2026.

## Why it exists

A room’s controls are in one place, its form in the main menu (#1735). This button is the way there from the room, at every width: in a narrow window the sidebar, with its own way in, is hidden. It is no menu: a second list of the room’s agents and controls was a second thing to keep right.

## Expected functionality

- It opens [the room’s form](../../sheets/settings/rooms.md) in the main menu: its title, its Members list, Wake chain limit… and Permissions…, and Delete… beside Save. Nothing opens between the click and the form.
- In Members, each agent’s row says what it does, then its backend, model, effort and state as text, with full model ids (“Claude Code · claude-sonnet-5-5 · not the model you set: claude-opus-5-5 · medium effort · idle”), as its row in the sidebar’s Agents section says. A mock agent says “mock” after its name (#12).
- An agent’s row follows the room while the form is open: its state changes as a turn starts and ends, and it says how many messages wait for it (“· 2 queued”), so every agent’s queue is in view without a pick.
- With an agent picked, the list’s bar has Edit, which shows its persona’s form with focus in its first field (#60), and a button that says how many messages wait for it (“2 messages queued”) and opens its queue (#427). The button follows the queue, and while nothing waits it stays, dimmed, and says why.
- Work is the top bar’s Work button, beside it.
- Closing the main menu returns focus to the button, including by Escape (#26).

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “Asset explorer” and press the gear after its title. Pick each agent in Members, press Edit, and go back.
3. Narrow the window to 375 px and do the same.

**Pass if:** The room’s form opens at once, each agent’s row says what its row in the sidebar says, with full model ids, Edit shows that agent’s persona, and closing returns focus to the gear.

## Related

- [top bar](top-bar.md)
- [Settings › Rooms](../../sheets/settings/rooms.md)
