# Settings: Rooms, and a room’s form

**Where:** Settings › Rooms. A conversation’s Manage button (the gear after its title in the top bar), the button beside its Agents heading, and `/rename` open the same form, on that room (#1735).

## Why it exists

A room’s title, its members and its permissions were each changed somewhere else: a rename sheet, + and − in the sidebar’s header, items of the ⋯ menu. Now every control of a room is in one place, managed as every other kind of thing is, and the other ways only open it.

## Expected functionality

- **The list** has every conversation and room by title, each with its agents and its project. The first row is picked. A click or the arrow keys move the pick, and focus goes with it.
- **The bar**, at the right end of the “Rooms” heading’s row above the list, acts on the pick and names it: + (New room), − (Delete…), Edit and Open. All four are in view at once, at every width, and stay in view as the list scrolls. In a narrow window they wrap under the heading, still at the right.
- The bar’s + leaves the menu for the [New room sheet](../new-conversation-and-room.md), in the project that’s open. Open leaves it for the room.
- − opens the [delete confirm](../delete-conversation.md) over the menu. Cancel returns to the list, with focus on −. Once the room is deleted, the menu closes.
- Edit, Enter or a double click shows **the room’s form** in the list’s place, with focus in Title, and “All rooms” to go back with the pick kept.
- **Title:** Enter or Save saves it. Opened from the list, Save goes back to the list; opened from the room itself, Save closes the menu and focus returns to where you opened it. There is no rename sheet of its own.
- **Members** lists the room’s agents and the people of this Postbox in one list. Its + and − are at the right end of the “Members” heading’s row, at every width. An agent’s row says what it does, then what it runs with and its state. The row follows the room while the form is open, and says how many messages wait for the agent. With an agent picked, the bar also has Edit, which shows its persona’s form, and a button that says how many messages wait and opens its queue; while nothing waits it stays, dimmed, and says why. + opens a menu of the agents you have that aren’t in the room, then New agent…; one pick adds an agent, and a toast says who joined. − removes the picked agent from the room, after a confirm that says so: “Remove critic from Planning?”, with what ends (its part here, and its session here: added back, it starts a new one and reads the room again) and what stays (its messages here, any apps it wrote here, the agent itself, its settings and other rooms). Its earlier messages keep its name with no mark, and the room gets a “critic left” line (#1743).
- − is off, dimmed and still in the tab order, when the pick is the room’s only agent or a person. The line under the list says why in words: the people of this Postbox are in every room, and a room keeps at least one agent.
- **More** has Permissions…, opening over the form.
- Delete… and Save are pinned under the form.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open Settings › Rooms. Move the pick with the arrow keys, and press Enter on “Index planning”.
3. Change Title to “Planning” and press Enter.
4. Open “Planning”, then press the gear after its title. Pick a person in Members, then an agent. Press +, add an agent, then remove it with −.
5. Back in Settings › Rooms, press − on a room, Cancel, then − again and delete it.

**Pass if:** In step 2 the bar’s buttons name each pick and focus follows it. In step 3 you are back on the list with “Planning” in it, and the top bar and sidebar say “Planning”. In step 4 − is off for the person and on for the agent, the added agent appears in the list and the sidebar, and it goes after its confirm. In step 5 Cancel leaves you on the list, and the delete closes the menu.

## Accessibility

- The list is a listbox of options, and its bar a toolbar. A control that’s off says so (`aria-disabled`) with its reason as its description, and the reason is on the page too.
- Escape closes the menu and returns focus to what opened it: the gear after the title, the Agents heading’s button, or the composer after `/rename`.

## How to check

`npx playwright test tests/browser/main-menu-lists.spec.mjs tests/browser/agents-add-remove.spec.mjs`. With real agents: `node tools/uat-run.mjs --scenario members --max-turns 30 --budget 2 --max-cost 8 --file no`.
