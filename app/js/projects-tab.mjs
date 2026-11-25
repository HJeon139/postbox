// The main menu’s Projects (#1735): the list of projects, each with its folder, where its pushes go and its actions,
// and a form for one at a time: a new project, or the repository a project pushes to. Moved out of app/js/sheets.mjs.

import { api, client } from './client.mjs';
import { h } from './dom.mjs';
import { heard } from './go-when-there.mjs';
import { barAction, barSign, formHead, pickList } from './manage-list.mjs';
import { confirmDeleteProject, deleteProjectButton, LAST } from './project-delete.mjs';
import { toast } from './ui.mjs';

const S = () => client.state;

/**
 * @param {() => void} paint  draws the tab again @param {(...actions: any[]) => null} setFoot  pins the tab’s actions
 * @param {Record<string, any>} at  what the tab is editing: a project’s id, 'new', or nothing
 */
export function projectsTab(paint, setFoot, at) {
  const back = () => {
    at.projects = null;
    paint();
  };
  const open = (/** @type {string} */ id, /** @type {string} */ focus) => {
    at.projects = id;
    paint();
    document.getElementById(focus)?.focus();
  };
  if (at.projects === 'new') return newProject(setFoot, back);
  const editing = at.projects ? S().projects[at.projects] : null;
  if (editing) return editProject(editing, setFoot, back);
  const only = Object.keys(S().projects).length < 2 ? LAST : '';
  const { list, bar } = pickList({
    label: 'Projects',
    at,
    name: 'pickedProject',
    empty: 'No projects yet.',
    rows: Object.values(S().projects).map((p) => ({
      key: p.id,
      name: p.name,
      className: 'project-row',
      facts: [p.folder, p.pushUrl ? `Pushes you ask for go to ${p.pushUrl}` : 'Pushes you ask for ask you first'],
    })),
    open: (r) => open(r.key, `pj-push-${r.key}`),
    controls: (r) => [
      barSign('+', 'New project', () => open('new', 'pj-n'), { id: 'pj-new' }),
      r && barSign('−', `Delete project ${r.name}…`, () => confirmDeleteProject(S().projects[r.key], paint), { off: only }),
      r && barAction('Edit', r.name, () => open(r.key, `pj-push-${r.key}`), { id: `pj-edit-${r.key}` }),
    ],
  });
  setFoot(bar);
  return [list];
}

/** @param {(...actions: any[]) => null} setFoot @param {() => void} back */
function newProject(setFoot, back) {
  const name = h('input.input', { id: 'pj-n', placeholder: 'Project name' });
  const folder = h('input.input', { id: 'pj-f', placeholder: '/Users/you/Documents/project', 'aria-describedby': 'pj-f-help' });
  const create = () =>
    api('/api/projects', { name: name.value, folder: folder.value })
      .then(async (made) => {
        toast({ title: `Created ${name.value || 'the project'}` });
        // Once the page has heard of it, so the list shows it, and the only project’s Delete turns on (#119).
        await heard(() => S().projects[made.id]);
        back();
      })
      .catch((e) => toast({ title: 'Couldn’t create the project', text: e.message, level: 'blocking' }));
  setFoot(h('span.grow'), h('button.btn.send', { type: 'button', onclick: create }, 'Create project'));
  return [
    ...formHead('All projects', back, 'New project'),
    h('div.field', h('label.label', { for: 'pj-n' }, 'Name'), name),
    h(
      'div.field',
      h('label.label', { for: 'pj-f' }, 'Root folder'),
      folder,
      h('span.help', { id: 'pj-f-help' }, 'The folder bounds the file picker and is where Claude Code sessions start.'),
    ),
  ];
}

/**
 * A project’s form: its folder, as it was made, and the repository a push you ask an agent for goes to (#296). Postbox
 * makes that push itself, to this repository only, so an agent can’t send it elsewhere by changing its git settings.
 * @param {any} p @param {(...actions: any[]) => null} setFoot @param {() => void} back
 */
function editProject(p, setFoot, back) {
  const id = `pj-push-${p.id}`;
  const input = h('input.input.mono', { id, value: p.pushUrl ?? '', placeholder: 'https://github.com/owner/name.git', 'aria-describedby': `${id}-help` });
  const save = () =>
    api(`/api/projects/${p.id}/push-url`, { url: input.value }, 'PUT')
      .then(() => {
        toast({ title: input.value.trim() ? `Pushes you ask for go to ${input.value.trim()}` : 'Pushes you ask for ask you first' });
        back();
      })
      .catch((e) => toast({ title: 'Couldn’t save the repository', text: e.message, level: 'blocking' }));
  setFoot(deleteProjectButton(p, back), h('span.grow'), h('button.btn.send', { type: 'button', onclick: save }, 'Save'));
  return [
    ...formHead('All projects', back, p.name),
    h(
      'div.field',
      h('span.label', 'Root folder'),
      h('span.mono', { style: { overflowWrap: 'anywhere' } }, p.folder),
      h('span.help', 'Set when the project was made.'),
    ),
    h(
      'div.field',
      h('label.label', { for: id }, 'Repository to push to'),
      input,
      h(
        'span.help',
        { id: `${id}-help` },
        'When you ask an agent to push, Postbox pushes its branch here itself. Empty, every push asks you first. A folder on this computer runs that repository’s own hooks when it receives a push.',
      ),
    ),
  ];
}
