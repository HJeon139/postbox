// Settings’ Projects tab: each project’s name and folder, the repository a push you ask for goes to, and a form that
// adds a project. Moved out of app/js/sheets.mjs.

import { api, client } from './client.mjs';
import { h, icon } from './dom.mjs';
import { toast } from './ui.mjs';

const S = () => client.state;

/**
 * The repository a push you ask an agent for goes to (#296). Postbox makes that push itself, to this repository only,
 * so an agent can’t send it elsewhere by changing its git settings. Empty, a push asks you on a card.
 * @param {any} p  the project
 */
function pushField(p) {
  const id = `pj-push-${p.id}`;
  const input = h('input.input.mono', { id, value: p.pushUrl ?? '', placeholder: 'https://github.com/owner/name.git' });
  const save = () =>
    api(`/api/projects/${p.id}/push-url`, { url: input.value }, 'PUT')
      .then(() => toast({ title: input.value.trim() ? `Pushes you ask for go to ${input.value.trim()}` : 'Pushes you ask for ask you first' }))
      .catch((e) => toast({ title: 'Couldn’t save the repository', text: e.message, level: 'blocking' }));
  return h(
    'div.field',
    h('label.label', { for: id }, 'Repository to push to'),
    h('div.row-flex', input, h('button.btn.sm', { type: 'button', onclick: save }, 'Save repository')),
    h(
      'p.small.dim',
      'When you ask an agent to push, Postbox pushes its branch here itself. Empty, every push asks you first. A folder on this computer runs that repository’s own hooks when it receives a push.',
    ),
  );
}

/** @param {() => void} paint  draws the tab again */
export function projectsTab(paint) {
  const name = h('input.input', { id: 'pj-n', placeholder: 'Project name' });
  const folder = h('input.input', { id: 'pj-f', placeholder: '/Users/you/Documents/project' });
  return [
    h(
      'ul.list-rows',
      Object.values(S().projects).map((p) =>
        h('li.col', h('div.row-flex', icon('folder', 'dim'), h('b', p.name), h('span.small.dim.mono.grow', p.folder)), pushField(p)),
      ),
    ),
    h(
      'div.form-grid',
      h('div.field', h('label.label', { for: 'pj-n' }, 'Name'), name),
      h('div.field', h('label.label', { for: 'pj-f' }, 'Root folder'), folder),
    ),
    h(
      'div.row-flex',
      h(
        'button.btn',
        {
          type: 'button',
          onclick: () =>
            api('/api/projects', { name: name.value, folder: folder.value })
              .then(() => {
                toast({ title: `Created ${name.value || 'the project'}` });
                paint();
              })
              .catch((e) => toast({ title: 'Couldn’t create the project', text: e.message, level: 'blocking' })),
        },
        icon('plus'),
        'Create project',
      ),
    ),
    h('p.small.dim', 'The folder bounds the file picker and is where Claude Code sessions start.'),
  ];
}
