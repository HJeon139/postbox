// The command palette, Jump to… (⌘K): conversations, the new-agent and settings sheets, and the appearance modes.
// The sheets come from its caller, shell.mjs, so this module doesn’t import sheets.mjs and join its import cycle.

import { api, client, sessionsOf } from './client.mjs';
import { h, icon } from './dom.mjs';
import { navigate, openDialog } from './ui.mjs';

const S = () => client.state;

/** @param {{ openNewAgent: (o: any) => void, openSettings: () => void }} sheets */
export function openPalette({ openNewAgent, openSettings }) {
  // Already open: ⌘K again goes back to its field rather than stacking a second palette.
  const open = document.querySelector('.dialog.palette input');
  if (open) return open.focus();
  const input = h('input.input', {
    'aria-label': 'Jump to a conversation, project, agent or action',
    placeholder: 'Jump to a conversation, an agent, or an action…',
    role: 'combobox',
    'aria-controls': 'p-list',
    'aria-expanded': 'true',
    autocomplete: 'off',
  });
  const list = h('ul.p-list', { id: 'p-list', role: 'listbox' });
  let sel = 0;
  const all = () => [
    ...Object.values(S().threads)
      .filter((t) => t.kind !== 'side' && !t.archived)
      .map((t) => ({
        label: t.title,
        sub: `${S().projects[t.projectId]?.name} · ${sessionsOf(t.id)
          .map((s) => s.handle)
          .join(', ')}`,
        icon: 'thread',
        run: () => navigate(`#/t/${t.id}`),
      })),
    { label: 'New agent', sub: 'From a boilerplate', icon: 'plus', run: () => openNewAgent({}) },
    { label: 'Settings', sub: 'Mode, personas, projects', icon: 'gear', run: () => openSettings() },
    ...['system', 'light', 'dark'].map((m) => ({
      label: `Switch to ${m === 'system' ? 'the system mode' : m + ' mode'}`,
      sub: 'Appearance',
      icon: 'moon',
      run: () => api('/api/settings', { theme: m }, 'PUT'),
    })),
  ];
  const paint = () => {
    const q = input.value.toLowerCase().trim();
    const items = all()
      .filter((x) => !q || `${x.label} ${x.sub}`.toLowerCase().includes(q))
      .slice(0, 12);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(
      ...items.map((x, i) =>
        h(
          'li',
          {
            role: 'option',
            id: `p-${i}`,
            'aria-selected': String(i === sel),
            onclick: () => {
              dlg.close();
              x.run();
            },
          },
          icon(x.icon, 'dim'),
          h('span.grow', x.label, h('span.small.dim', { style: { display: 'block' } }, x.sub)),
        ),
      ),
    );
    input.setAttribute('aria-activedescendant', `p-${sel}`);
    return items;
  };
  input.addEventListener('input', () => {
    sel = 0;
    paint();
  });
  input.addEventListener('keydown', (e) => {
    const items = paint();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      sel = (sel + 1) % items.length;
      paint();
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel - 1 + items.length) % items.length;
      paint();
    }
    if (e.key === 'Enter' && items[sel]) {
      e.preventDefault();
      dlg.close();
      items[sel].run();
    }
  });
  paint();
  const dlg = openDialog({ title: 'Jump to…', body: [input, list], size: 'palette', initialFocus: () => input });
}
