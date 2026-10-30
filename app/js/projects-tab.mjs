// Settings’ Projects tab: each project’s name and folder, and a form that adds one. Moved out of app/js/sheets.mjs.

import { api, client } from './client.mjs';
import { h, icon } from './dom.mjs';
import { toast } from './ui.mjs';

const S = () => client.state;

/** @param {() => void} paint  draws the tab again */
export function projectsTab(paint) {
  const name = h('input.input', { id: 'pj-n', placeholder: 'Project name' });
  const folder = h('input.input', { id: 'pj-f', placeholder: '/Users/you/Documents/project' });
  return [
    h(
      'ul.list-rows',
      Object.values(S().projects).map((p) => h('li', icon('folder', 'dim'), h('b', p.name), h('span.small.dim.mono.grow', p.folder))),
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
