// The New conversation sheet: a direct message with one agent, or a room with several. Moved from sheets.mjs.

import { api, client } from './client.mjs';
import { h, icon } from './dom.mjs';
import { goToNew } from './go-when-there.mjs';
import { keepFocus, openDialog } from './ui.mjs';

const S = () => client.state;

/**
 * A new conversation: a direct message with one agent, or a room with several. Picking a second agent makes
 * it a room; { room: true } starts with that intent and asks for at least two.
 */
export function openNewThread(projectId, { room = false } = {}) {
  const personas = Object.values(S().personas).filter((p) => !p.retired);
  const picked = new Set(room ? [] : personas.slice(0, 1).map((p) => p.id));
  const title = h('input.input', { id: 'nt-title', placeholder: room ? 'What will the room work on?' : 'What’s it about?' });
  const list = h('div.chips', { role: 'group', 'aria-label': 'Agents' });
  const err = h('div');
  const startBtn = h('button.btn.send', { type: 'button', onclick: () => create() });
  const paint = () => keepFocus(list, repaint);
  const repaint = () => {
    list.replaceChildren(
      ...personas.map((p) =>
        h(
          'button.chip',
          {
            type: 'button',
            'aria-pressed': String(picked.has(p.id)),
            class: picked.has(p.id) ? 'on' : '',
            onclick: () => {
              if (picked.has(p.id)) picked.delete(p.id);
              else picked.add(p.id);
              paint();
            },
          },
          p.handle,
        ),
      ),
    );
    startBtn.textContent = picked.size > 1 ? `Start a room with ${picked.size} agents` : 'Start conversation';
  };
  paint();
  const create = async () => {
    if (!picked.size || (room && picked.size < 2)) {
      err.replaceChildren(h('span.err', { role: 'alert' }, icon('warn'), room ? 'Pick at least two agents for a room.' : 'Pick an agent.'));
      return;
    }
    try {
      const t = await api('/api/threads', {
        projectId,
        title: title.value.trim() || (picked.size > 1 ? 'New room' : 'New conversation'),
        personaIds: [...picked],
      });
      dlg.close();
      goToNew(t.id);
    } catch (e) {
      err.replaceChildren(h('span.err', { role: 'alert' }, icon('warn'), e.message));
    }
  };
  const dlg = openDialog({
    title: room ? 'New room' : 'New conversation',
    sub: `${S().projects[projectId]?.name ?? ''} · ${room ? 'Several agents in one conversation. The last to speak answers anything not addressed with @.' : 'One agent, or pick more to make a room.'}`,
    body: [h('div.field', h('label.label', { for: 'nt-title' }, 'Name'), title), h('div.field', h('span.label', 'With'), list), err],
    foot: [h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), startBtn],
  });
}
