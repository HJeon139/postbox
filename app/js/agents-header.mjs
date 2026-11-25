// The Agents header’s way to the room’s members (#558): one button that opens the main menu’s form for this room,
// where its Members list has the + and − that used to be here (#1620). Controls live in one place; this only goes there.

import { h, icon } from './dom.mjs';

/**
 * The button beside the conversation’s Agents heading. `count` is kept for the caller, which told − how many agents
 * were here; nothing reads it now. openSettings comes from the caller: sheets.mjs reaches this module through the
 * shell, so importing it here would grow an import cycle (#312).
 * @param {string} threadId @param {{ openSettings: Function }} sheets
 */
export function agentsHeaderButtons(threadId, sheets) {
  // One way in (#558): the room’s members are added and removed in the main menu’s form for the room, not here.
  const el = h(
    'span.agents-head-btns',
    h(
      'button.btn.ghost.icon.sm',
      {
        type: 'button',
        'aria-label': 'Manage this conversation’s members',
        title: 'Manage members',
        'aria-haspopup': 'dialog',
        onclick: () => sheets.openSettings('rooms', threadId),
      },
      icon('gear'),
    ),
  );
  return { el, count: (/** @type {number} */ _n) => {} };
}
