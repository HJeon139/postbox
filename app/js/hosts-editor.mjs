// A host’s settings editor, on its card in the Hosts tab (app/js/hosts.mjs): its ssh destination, its settings in
// the design’s groups (hosts-settings.mjs, hosts-fields.mjs) and each project’s folder there. Save checks
// everything as the server does, says which fields need a change, and then saves the host and each changed folder.

import { checkDestination, checkHostPath, checkHostSettings } from '/shared/remote-settings.mjs';
import { api, client } from './client.mjs';
import { h, plural } from './dom.mjs';
import { errEl, field } from './hosts-fields.mjs';
import { showError } from './hosts-parts.mjs';
import { FIELDS, GROUPS, PROGRAMS_HELP, parse, shown } from './hosts-settings.mjs';
import { toast } from './ui.mjs';

const S = () => client.state;

/** @typedef {import('./hosts.mjs').Panel} Panel @typedef {import('./hosts-fields.mjs').Ed} Ed */

/** @param {Panel} p @param {any} host @param {string} [focus]  a setting whose field gets focus */
export const openEditor = (p, host, focus) => {
  p.editing = host.id;
  p.errors = {};
  p.formError = '';
  p.draft = { name: host.name, v: {}, folders: {} };
  for (const f of FIELDS) p.draft.v[f.key] = shown(f, host.settings);
  for (const pr of Object.values(S().projects)) p.draft.folders[pr.id] = pr.hostFolders?.[host.id] ?? '';
  p.paint();
  document.getElementById(`ho-${host.id}-${focus ?? 'name'}`)?.focus();
};
/** @param {Panel} p */
export const closeEditor = (p) => {
  const id = p.editing;
  p.editing = null;
  p.draft = null;
  p.paint();
  if (id) document.getElementById(`ho-${id}-edit`)?.focus();
};

/** The editor, under the host’s status. @param {Panel} p @param {any} host */
export const editor = (p, host) => {
  const id = host.id;
  /** @type {Ed} */
  const ed = { p, host, d: /** @type {NonNullable<Panel['draft']>} */ (p.draft), fid: (key) => `ho-${id}-${key.replace('.', '-')}` };
  return h(
    'div.ho-editor',
    { style: { display: 'flex', flexDirection: 'column', gap: '14px', borderTop: '1px solid var(--line)', paddingTop: '12px' } },
    nameField(ed),
    GROUPS.map(([group, fields]) =>
      h(
        'section',
        { 'aria-labelledby': `ho-${id}-g-${group}`, style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('h4.label', { id: `ho-${id}-g-${group}`, style: { margin: 0 } }, group),
        group === 'Programs' ? h('p.help', { id: `ho-${id}-programs-help`, style: { margin: 0 } }, PROGRAMS_HELP) : null,
        h(
          'div.form-grid',
          fields.map((f) => field(ed, f)),
        ),
      ),
    ),
    foldersSection(ed),
    h('p.err', { id: `ho-${id}-form-err`, role: 'alert', hidden: !p.formError }, p.formError),
    h(
      'div.row-flex.wrap',
      h('button.btn.send', { type: 'button', id: `ho-${id}-save`, disabled: p.saving, onclick: () => save(p, host) }, p.saving ? 'Saving…' : 'Save'),
      h('button.btn', { type: 'button', id: `ho-${id}-cancel`, onclick: () => closeEditor(p) }, 'Cancel'),
    ),
  );
};

/** The host’s ssh destination. @param {Ed} ed */
const nameField = (ed) => {
  const { p, d, fid } = ed;
  return h(
    'div.field',
    h('label.label', { for: fid('name') }, 'SSH destination'),
    h('input.input.mono', {
      id: fid('name'),
      value: d.name,
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-describedby': `${fid('name')}-help ${fid('name')}-err`,
      'aria-errormessage': `${fid('name')}-err`,
      'aria-invalid': p.errors.name ? 'true' : null,
      oninput: (e) => {
        d.name = e.target.value;
      },
      onchange: () => {
        const r = checkDestination(d.name);
        p.errors.name = r.ok ? '' : r.error;
        showError(document.getElementById(`${fid('name')}-err`), p.errors.name);
      },
    }),
    errEl(ed, 'name'),
    h('span.help', { id: `${fid('name')}-help` }, 'Renaming it points it at another machine, so it can’t be renamed while turns run there.'),
  );
};

/** Each project’s folder on the host. @param {Ed} ed */
const foldersSection = (ed) => {
  const id = ed.host.id;
  const projects = Object.values(S().projects);
  return h(
    'section',
    { 'aria-labelledby': `ho-${id}-g-folders`, style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    h('h4.label', { id: `ho-${id}-g-folders`, style: { margin: 0 } }, 'Project folders on this host'),
    h(
      'p.help',
      { id: `ho-${id}-folders-help`, style: { margin: 0 } },
      'Where each project’s agents work on this host: an absolute path there, starting with /. Empty: each agent works in ~/postbox-work/ and its handle there.',
    ),
    projects.length
      ? h(
          'div.form-grid',
          projects.map((pr) => folderField(ed, pr)),
        )
      : h('p.empty-note', 'No projects yet.'),
  );
};

/** One project’s folder on the host. @param {Ed} ed @param {any} pr */
const folderField = (ed, pr) => {
  const { p, d } = ed;
  const cid = `ho-${ed.host.id}-pf-${pr.id}`;
  const folderLabel = `The project’s folder on ${d.name || ed.host.name}`;
  return h(
    'div.field.span',
    h('label.label', { for: cid }, pr.name),
    h('input.input.mono', {
      id: cid,
      value: d.folders[pr.id] ?? '',
      placeholder: '/home/you/project',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-describedby': `ho-${ed.host.id}-folders-help ${cid}-err`,
      'aria-errormessage': `${cid}-err`,
      'aria-invalid': p.errors[`pf:${pr.id}`] ? 'true' : null,
      oninput: (e) => {
        d.folders[pr.id] = e.target.value;
      },
      onchange: () => {
        const v = d.folders[pr.id].trim();
        const r = v ? checkHostPath(v, folderLabel) : { ok: true };
        p.errors[`pf:${pr.id}`] = r.ok ? '' : /** @type {any} */ (r).error;
        showError(document.getElementById(`${cid}-err`), p.errors[`pf:${pr.id}`]);
      },
    }),
    h('span.err', { id: `${cid}-err`, hidden: !p.errors[`pf:${pr.id}`] }, p.errors[`pf:${pr.id}`] ?? ''),
  );
};

/**
 * Checks every field as the server would, keeping each error under its field: the settings, the destination, and
 * each project’s folder that changed.
 * @param {Panel} p @param {any} host
 */
function collect(p, host) {
  const d = /** @type {NonNullable<Panel['draft']>} */ (p.draft);
  p.errors = {};
  /** @type {Record<string, any>} */
  const settings = {};
  /** @type {Record<string, number>} */
  const keepAlive = {};
  for (const f of FIELDS) {
    const r = parse(f, d.v[f.key], host.settings);
    if (!r.ok) p.errors[f.key] = r.error;
    else if (f.key.startsWith('keepAlive.')) keepAlive[f.key.slice(10)] = r.value;
    else settings[f.key] = r.value;
  }
  settings.keepAlive = keepAlive;
  const dest = checkDestination(d.name);
  if (!dest.ok) p.errors.name = dest.error;
  const folderLabel = `The project’s folder on ${dest.ok ? dest.value : host.name}`;
  /** @type {[string, string | null][]} */
  const folders = [];
  for (const pr of Object.values(S().projects)) {
    const v = (d.folders[pr.id] ?? '').trim();
    if (v === (pr.hostFolders?.[host.id] ?? '')) continue;
    const r = v ? checkHostPath(v, folderLabel) : { ok: true };
    if (!r.ok) p.errors[`pf:${pr.id}`] = /** @type {any} */ (r).error;
    else folders.push([pr.id, v || null]);
  }
  return { settings, dest, folders };
}

/** Checks everything, then saves what changed: the host, then each project’s folder. @param {Panel} p @param {any} host */
const save = async (p, host) => {
  const { settings, dest, folders } = collect(p, host);
  const { errors } = p;
  const bad = Object.keys(errors).filter((k) => errors[k]);
  if (!bad.length) {
    const all = checkHostSettings(settings, host.settings);
    if (!all.ok) errors.form = all.error;
  }
  if (bad.length || errors.form) {
    p.formError = errors.form ?? `${plural(bad.length, 'field needs', 'fields need')} a change before this can be saved: see the message under each.`;
    p.paint();
    const first = bad[0];
    document
      .getElementById(
        first ? (first.startsWith('pf:') ? `ho-${host.id}-pf-${first.slice(3)}` : `ho-${host.id}-${first.replace('.', '-')}`) : `ho-${host.id}-save`,
      )
      ?.focus();
    return;
  }
  p.formError = '';
  p.saving = true;
  p.paint();
  try {
    await api(`/api/hosts/${host.id}`, { ...(dest.value !== host.name ? { name: dest.value } : {}), settings }, 'PATCH');
    for (const [pid, folder] of folders) await api(`/api/projects/${pid}/hosts/${host.id}/folder`, { folder }, 'PUT');
    p.saving = false;
    toast({ title: `Saved ${dest.value}` });
    closeEditor(p);
  } catch (e) {
    p.saving = false;
    p.formError = [e.message, e.next].filter(Boolean).join(' ');
    p.paint();
    document.getElementById(`ho-${host.id}-save`)?.focus();
  }
};
