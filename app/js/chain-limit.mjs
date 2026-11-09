// A room’s wake chain limit (#1035): agent wakes in a row, without you, before the next waits for your Allow. The room’s
// own, saved on its conversation, else the server’s default from /api/state, since this page’s shared/limits.mjs knows
// only the built-in one. The dialog the room’s “Actions for …” menu opens sets or clears it; only the person can
// (server/room-chain-limit.mjs).

import { HOP_LIMIT, MAX_HOP_LIMIT, ROOM_CHAIN_LIMIT_TAKES } from '/shared/limits.mjs';
import { api, client } from './client.mjs';
import { h } from './dom.mjs';
import { openDialog } from './ui.mjs';

const COUNT = new Intl.NumberFormat('en-US');
/** A count as the person reads it: 1,000. @param {number} n */
export const countText = (n) => COUNT.format(n);

/** The server’s limit for a room with none of its own. */
const serverDefault = () => client.config?.defaultChainLimit ?? HOP_LIMIT;

/**
 * The chain limit of the room a thread is in: its conversation’s own (own, or null), and the limit that applies.
 * @param {string} threadId  the conversation, or one of its topic or side threads
 * @returns {{ own: number|null, limit: number }}
 */
export function roomChainLimit(threadId) {
  const t = client.state.threads[threadId];
  const conv = t?.kind === 'topic' || t?.kind === 'side' ? client.state.threads[t.parentId] : t;
  const own = conv?.chainLimit ?? null;
  return { own, limit: own ?? serverDefault() };
}

/** What the room’s menu says of its limit: “1,000 wakes in a row, the default”. @param {string} threadId */
export function chainLimitDesc(threadId) {
  const { own, limit } = roomChainLimit(threadId);
  return `${countText(limit)} wakes in a row${own === null ? ', the default' : ''}`;
}

/** The dialog that sets the room’s chain limit, or clears it to the server’s default. */
export function openChainLimit(threadId) {
  const input = h('input.input', {
    id: 'cl-limit',
    type: 'number',
    min: '1',
    max: String(MAX_HOP_LIMIT),
    step: '1',
    inputmode: 'numeric',
    value: roomChainLimit(threadId).own ?? '',
    placeholder: countText(serverDefault()),
    'aria-describedby': 'cl-limit-help',
    'aria-errormessage': 'cl-limit-err',
  });
  const err = h('span.err', { id: 'cl-limit-err', role: 'alert', hidden: true });
  /** A refusal shows under the field and keeps the dialog open, with what was typed. @param {string} message */
  const refused = (message) => {
    err.textContent = message;
    err.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  };
  const send = (chainLimit) =>
    api(`/api/threads/${threadId}`, { chainLimit }, 'PATCH')
      .then(() => dlg.close())
      .catch((e) => refused(e.message));
  // Empty is the default. Text the field can’t read as a number (badInput) reads as empty, so it’s refused here; the
  // rest goes as typed, so the server refuses 2.5 or 0 rather than the page rounding them.
  const save = () => {
    if (input.validity.badInput) return refused(ROOM_CHAIN_LIMIT_TAKES);
    const text = input.value.trim();
    return send(text ? Number(text) : null);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void save();
  });
  const dlg = openDialog({
    title: 'Wake chain limit',
    body: [
      h(
        'div.field',
        h('label.label', { for: 'cl-limit' }, 'Agent wakes in a row'),
        input,
        err,
        h(
          'span.help',
          { id: 'cl-limit-help' },
          `After this many agent wakes without your message, the next waits for your Allow. Empty, it’s the default of ${countText(serverDefault())}.`,
        ),
      ),
    ],
    foot: [
      h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button.btn', { type: 'button', onclick: () => send(null) }, 'Use the default'),
      h('button.btn.send', { type: 'button', onclick: save }, 'Save'),
    ],
    initialFocus: () => input,
  });
}
