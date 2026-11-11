// The command palette, Jump to… (⌘K), the top bar’s one search (#1233): conversations, the new-agent and settings
// sheets, the appearance modes and, in a conversation, the messages there that match (message-hits.mjs). The sheets
// come from its caller, shell.mjs, so this module doesn’t import sheets.mjs and join its import cycle.

import { api, client, sessionsOf } from './client.mjs';
import { h, icon } from './dom.mjs';
import { messageRows } from './message-hits.mjs';
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

/** The rows for query q: what it jumps to, then the open conversation’s messages that match. @param {ReturnType<typeof jumps>} all @param {string | null} threadId @param {string} q @returns {Row[]} */
function rowsFor(all, threadId, q) {
  const lower = q.toLowerCase();
  const found = all.filter((x) => !lower || x.text.includes(lower)).slice(0, JUMPS);
  return threadId && q ? [...found, ...messageRows(threadId, q)] : found;
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

/** Opens the palette; again while open, goes back to its field. @param {{ openNewAgent: (o: any) => void, openSettings: () => void }} sheets */
export function openPalette(sheets) {
  const open = /** @type {HTMLInputElement | null} */ (document.querySelector('.dialog.palette input'));
  if (open) return open.focus();
  const r = route();
  const threadId = r.view === 'thread' ? r.threadId : null;
  const all = jumps(sheets);
  const input = field();
  const list = h('ul.p-list', { id: 'p-list', role: 'listbox', 'aria-label': 'Results' });
  /** @type {Row[]} */
  let rows = [];
  let sel = 0;
  let queued = 0;
  const go = (/** @type {Row} */ x) => {
    dlg.close();
    x.run();
  };
  const paint = () => {
    const li = (/** @type {Row} */ x, /** @type {number} */ i) =>
      h(
        'li',
        { role: 'option', id: `p-${i}`, 'aria-selected': String(i === sel), dataset: x.item ? { item: x.item } : {}, onclick: () => go(x) },
        ...x.content,
      );
    list.replaceChildren(...rows.map(li));
    if (rows.length) input.setAttribute('aria-activedescendant', `p-${sel}`);
    else input.removeAttribute('aria-activedescendant');
  };
  // A query runs at most once a frame while you type: a long conversation’s search isn’t free.
  const run = () => {
    queued = 0;
    rows = rowsFor(all, threadId, input.value.trim());
    sel = 0;
    paint();
  };
  input.addEventListener('input', () => {
    if (!queued) queued = requestAnimationFrame(run);
  });
  input.addEventListener('keydown', (e) => {
    if (!rows.length || !['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Enter') return go(rows[sel]);
    sel = (sel + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
    paint();
  });
  // Another conversation, or Back: a message hit is this room’s, so the palette closes rather than jump into a room you’ve left.
  const left = () => dlg.close();
  addEventListener('hashchange', left);
  run();
  const dlg = openDialog({
    title: 'Jump to…',
    body: [input, list],
    size: 'palette',
    initialFocus: () => input,
    onClose: () => removeEventListener('hashchange', left),
  });
}
