// The command palette, Jump to… (⌘K), the top bar’s one search (#1233): conversations, the new-agent and settings
// sheets, the appearance modes and, in a conversation, the messages there that match (message-hits.mjs). The sheets
// come from its caller, shell.mjs, so this module doesn’t import sheets.mjs and join its import cycle.

import { api, client, sessionsOf } from './client.mjs';
import { h, icon } from './dom.mjs';
import { messageAsker } from './message-hits.mjs';
import { navigate, openDialog, route } from './ui.mjs';

const S = () => client.state;
const JUMPS = 12;

/** @typedef {{ content: (Node | string)[], run: () => void, item?: string }} Row */

/** A row with an icon, a name, and a line under it. @param {string} name @param {string} label @param {string} sub @param {() => void} run @returns {Row} */
const row = (name, label, sub, run) => ({
  content: [icon(name, 'dim'), h('span.grow', label, h('span.small.dim', { style: { display: 'block' } }, sub))],
  run,
});

/** Everything the palette jumps to, with the text a query matches. @param {{ openNewAgent: (o: any) => void, openSettings: () => void }} sheets */
function jumps({ openNewAgent, openSettings }) {
  const threads = Object.values(S().threads).filter((t) => t.kind !== 'side' && !t.archived);
  const rows = [
    ...threads.map((t) => {
      const sub = `${S().projects[t.projectId]?.name} · ${sessionsOf(t.id)
        .map((s) => s.handle)
        .join(', ')}`;
      return { text: `${t.title} ${sub}`, ...row('thread', t.title, sub, () => navigate(`#/t/${t.id}`)) };
    }),
    { text: 'New agent From a boilerplate', ...row('plus', 'New agent', 'From a boilerplate', () => openNewAgent({})) },
    { text: 'Settings Mode, personas, projects', ...row('gear', 'Settings', 'Mode, personas, projects', () => openSettings()) },
    ...['system', 'light', 'dark'].map((m) => {
      const label = `Switch to ${m === 'system' ? 'the system mode' : `${m} mode`}`;
      return { text: `${label} Appearance`, ...row('moon', label, 'Appearance', () => api('/api/settings', { theme: m }, 'PUT')) };
    }),
  ];
  return rows.map((r) => ({ ...r, text: r.text.toLowerCase() }));
}

/** What query q jumps to. @param {ReturnType<typeof jumps>} all @param {string} q */
function jumpRows(all, q) {
  const lower = q.toLowerCase();
  return all.filter((x) => !lower || x.text.includes(lower)).slice(0, JUMPS);
}

/** One row in the list, as an option of the field’s listbox. @param {Row} x @param {number} i @param {boolean} chosen @param {(x: Row) => void} go */
const option = (x, i, chosen, go) =>
  h('li', { role: 'option', id: `p-${i}`, 'aria-selected': String(chosen), dataset: x.item ? { item: x.item } : {}, onclick: () => go(x) }, ...x.content);

/** What a query found, said by the status line for a screen reader. @param {string} q @param {number} n */
function found(q, n) {
  if (!q) return '';
  return n ? `${n} found` : 'Nothing found';
}

/** The field, a combobox over the list. */
const field = () =>
  h('input.input', {
    'aria-label': 'Jump to a conversation, an agent, an action or a message',
    placeholder: 'Jump to a conversation, an agent, or an action, or find a message…',
    role: 'combobox',
    'aria-controls': 'p-list',
    'aria-expanded': 'true',
    autocomplete: 'off',
  });

/**
 * The palette's list under its field: its rows, the one chosen, and the keys that move and pick. Enter pressed before
 * the messages are back, with nothing else found, acts on them once they are.
 * @param {HTMLInputElement} input @param {HTMLElement} list @param {HTMLElement} status @param {(x: Row) => void} go
 */
function results(input, list, status, go) {
  /** @type {Row[]} */
  let rows = [];
  let sel = 0;
  const paint = () => {
    list.replaceChildren(...rows.map((x, i) => option(x, i, i === sel, go)));
    if (rows.length) input.setAttribute('aria-activedescendant', `p-${sel}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const show = (/** @type {string} */ q, /** @type {Row[]} */ next) => {
    rows = next;
    status.textContent = found(q, rows.length);
    paint();
  };
  return {
    /** A query's rows, the first chosen. @param {string} q @param {Row[]} next */
    set(q, next) {
      sel = 0;
      show(q, next);
    },
    /** More rows for the same query: the messages, once the server answers. @param {string} q @param {Row[]} more */
    add: (q, more) => show(q, [...rows, ...more]),
    /** @param {KeyboardEvent} e @param {Promise<void> | null} waiting */
    key(e, waiting) {
      if (e.key === 'Enter' && !rows.length && waiting) {
        e.preventDefault();
        void waiting.then(() => rows.length && go(rows[sel]));
        return;
      }
      if (!rows.length || !['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
      e.preventDefault();
      if (e.key === 'Enter') return go(rows[sel]);
      sel = (sel + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      paint();
    },
  };
}

/** Opens the palette; again while open, goes back to its field. @param {{ openNewAgent: (o: any) => void, openSettings: () => void }} sheets */
export function openPalette(sheets) {
  const open = /** @type {HTMLInputElement | null} */ (document.querySelector('.dialog.palette input'));
  if (open) return open.focus();
  const r = route();
  const threadId = r.view === 'thread' ? r.threadId : null;
  const all = jumps(sheets);
  const input = /** @type {HTMLInputElement} */ (field());
  const list = h('ul.p-list', { id: 'p-list', role: 'listbox', 'aria-label': 'Results' });
  const status = h('p.small.dim.sr-only', { role: 'status' });
  const shown = results(input, list, status, (x) => {
    dlg.close();
    x.run();
  });
  // The open conversation’s messages, after what the query jumps to, once the server answers (#1155).
  const messages = threadId ? messageAsker(threadId, shown.add) : null;
  let queued = 0;
  // A query runs at most once a frame while you type: a long conversation’s search isn’t free.
  const run = () => {
    queued = 0;
    const q = input.value.trim();
    shown.set(q, jumpRows(all, q));
    messages?.ask(q);
  };
  input.addEventListener('input', () => {
    if (!queued) queued = requestAnimationFrame(run);
  });
  input.addEventListener('keydown', (e) => {
    // Typed or pasted and Enter at once: the query still waiting for its frame runs first, so a key acts on its rows.
    if (queued) {
      cancelAnimationFrame(queued);
      run();
    }
    shown.key(e, messages ? messages.pending() : null);
  });
  // Another conversation, or Back: a message hit is this room’s, so the palette closes rather than jump into a room you’ve left.
  const left = () => dlg.close();
  addEventListener('hashchange', left);
  run();
  const dlg = openDialog({
    title: 'Jump to…',
    body: [input, status, list],
    size: 'palette',
    initialFocus: () => input,
    onClose: () => {
      removeEventListener('hashchange', left);
      messages?.stop();
    },
  });
}
