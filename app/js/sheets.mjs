// Dialogs: new agent, new thread, settings (appearance, personas, projects, connection), the command
// palette, the delete confirm, and the project folder picker.

import { h, fill, icon, plural } from './dom.mjs';
import { client, api, threadsOf, sessionsOf } from './client.mjs';
import { ringFor } from './ring.mjs';
import { openDialog, toast, navigate } from './ui.mjs';

const S = () => client.state;
const toolsInProject = (projectId) => new Set(Object.values(S().sessions).filter((se) => S().threads[se.threadId]?.projectId === projectId).flatMap((se) => S().personas[se.personaId]?.tools ?? []));

// ── New agent ───────────────────────────────────────────────────────────────────────────

export function openNewAgent({ threadId = null, preset = null, onCreated = null } = {}) {
  const t = threadId ? S().threads[threadId] : null;
  const projectId = t?.projectId ?? Object.keys(S().projects)[0];
  const bps = Object.values(S().boilerplates);
  const st = { bp: preset ? null : bps[1]?.id ?? bps[0]?.id, handle: preset?.handle ?? '', instructions: preset?.instructions ?? bps[1]?.instructions ?? '', description: preset?.description ?? bps[1]?.description ?? '',
    tools: new Set(preset?.tools ?? bps[1]?.tools ?? []), where: threadId ? 'join' : 'new', saveBp: false, error: null };
  const have = toolsInProject(projectId);
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  const paint = () => {
    fill(body, 
      preset ? null : h('div.field', h('span.label', 'Start from'), h('div.chips', { role: 'radiogroup', 'aria-label': 'Boilerplate' }, bps.map((b) => h('button.chip', {
        type: 'button', role: 'radio', 'aria-checked': String(st.bp === b.id), class: st.bp === b.id ? 'on' : '',
        onclick: () => { st.bp = b.id; st.instructions = b.instructions; st.description = b.description; st.tools = new Set(b.tools); paint(); },
      }, b.name)))),
      h('div.form-grid',
        h('div.field', h('label.label', { for: 'na-h' }, 'Name'), h('div.row-flex', { style: { gap: 0 } }, h('span.pill', { style: { height: '32px', borderRadius: '6px 0 0 6px' } }, '@'),
          h('input.input', { id: 'na-h', value: st.handle, style: { borderRadius: '0 6px 6px 0' }, 'aria-describedby': 'na-h-help', oninput: (e) => { st.handle = e.target.value.replace(/^@/, ''); } })),
          h('span.help', { id: 'na-h-help' }, '2–24 letters, digits, - or _')),
        h('div.field', h('span.label', 'Runs on'), h('div.seg', { role: 'radiogroup', 'aria-label': 'Runs on' },
          h('button', { type: 'button', role: 'radio', 'aria-pressed': 'true' }, 'Mock agent'),
          h('button', { type: 'button', role: 'radio', 'aria-pressed': 'false', disabled: true, title: 'Arrives in Stage 3' }, 'Agent SDK'),
          h('button', { type: 'button', role: 'radio', 'aria-pressed': 'false', disabled: true, title: 'Arrives in Stage 3' }, 'Claude Code')),
          h('span.help', 'Real models arrive with the Stage 3 adapters.')),
        h('div.field.span', h('label.label', { for: 'na-d' }, 'What it does'), h('input.input', { id: 'na-d', value: st.description, oninput: (e) => { st.description = e.target.value; } })),
        h('div.field.span', h('label.label', { for: 'na-i' }, 'Instructions'), h('textarea.textarea', { id: 'na-i', style: { minHeight: '88px' }, oninput: (e) => { st.instructions = e.target.value; } }, st.instructions))),
      h('fieldset', { style: { border: 0, padding: 0, margin: 0 } }, h('legend.label', 'Tools'), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' } },
        S().config ? null : null, (client.config.knownTools ?? []).map(([id, label]) => {
          const on = st.tools.has(id);
          return h('span.check', { role: 'checkbox', tabindex: '0', 'aria-checked': String(on), onclick: () => { if (on) st.tools.delete(id); else st.tools.add(id); paint(); },
            onkeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.currentTarget.click(); } } },
          h('span.box'), h('span.mono', id), h('span.small', { style: { color: on && !have.has(id) ? 'var(--accent)' : 'var(--dim)' } }, on && !have.has(id) ? 'New grant · no agent in this project has it yet' : label));
        }))),
      h('div.field', h('span.label', 'Where it works'), h('div', { role: 'radiogroup', 'aria-label': 'Where it works', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        threadId ? whereOpt('join', 'Join this thread', `${t.title} becomes a room. It gets the recent messages and a short brief.`) : null,
        whereOpt('new', `New thread in ${S().projects[projectId]?.name}`, 'Starts fresh. @ it from anywhere to bring it in.'))),
      st.error ? h('span.err', { role: 'alert' }, icon('warn'), st.error) : null);
  };
  const whereOpt = (v, title, sub) => h('button.btn', { type: 'button', role: 'radio', 'aria-checked': String(st.where === v), style: { height: 'auto', justifyContent: 'flex-start', padding: '10px 12px', borderColor: st.where === v ? 'var(--accent)' : null }, onclick: () => { st.where = v; paint(); } },
    h('span', { style: { textAlign: 'left', whiteSpace: 'normal' } }, h('b', title), h('span.small.dim', { style: { display: 'block' } }, sub)));
  paint();
  const create = async () => {
    try {
      const p = await api('/api/personas', { handle: st.handle, description: st.description, instructions: st.instructions, tools: [...st.tools], backend: 'mock', model: 'mock',
        saveAsBoilerplate: st.saveBp, join: st.where === 'join' ? { threadId } : { projectId, title: `With @${st.handle}` } });
      dlg.close();
      toast({ title: `Created @${p.handle}` });
      onCreated?.(p);
      if (st.where === 'new') setTimeout(() => { const nt = threadsOf(projectId).find((x) => sessionsOf(x.id).some((se) => se.personaId === p.id)); if (nt) navigate(`#/t/${nt.id}`); }, 200);
    } catch (e) { st.error = e.message; paint(); body.querySelector('#na-h')?.focus(); }
  };
  const saveBp = h('span.check', { role: 'checkbox', tabindex: '0', 'aria-checked': 'false', style: { marginRight: 'auto' }, onclick: (e) => { st.saveBp = !st.saveBp; e.currentTarget.setAttribute('aria-checked', String(st.saveBp)); },
    onkeydown: (e) => { if (e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } } }, h('span.box'), h('span.small', 'Save as a boilerplate'));
  const dlg = openDialog({ title: preset ? `Edit @${preset.handle} before creating it` : 'New agent', sub: `Starts a new session in ${S().projects[projectId]?.name}. You can edit it later under Personas.`, size: 'lg', body,
    foot: [saveBp, h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button.btn.send', { type: 'button', onclick: create }, 'Create agent')],
    initialFocus: () => body.querySelector('#na-h') });
}

// ── New thread ──────────────────────────────────────────────────────────────────────────

export function openNewThread(projectId) {
  let pick = Object.values(S().personas).find((p) => !p.retired)?.id;
  const title = h('input.input', { id: 'nt-title', placeholder: 'What’s it about?' });
  const list = h('div.chips', { role: 'radiogroup', 'aria-label': 'Agent' });
  const paint = () => list.replaceChildren(...Object.values(S().personas).filter((p) => !p.retired).map((p) => h('button.chip', { type: 'button', role: 'radio', 'aria-checked': String(pick === p.id), class: pick === p.id ? 'on' : '', onclick: () => { pick = p.id; paint(); } }, `@${p.handle}`)));
  paint();
  const create = async () => {
    try {
      const t = await api('/api/threads', { projectId, title: title.value.trim() || 'New thread', personaIds: [pick] });
      dlg.close();
      navigate(`#/t/${t.id}`);
    } catch (e) { toast({ title: 'Couldn’t start the thread', text: e.message, level: 'blocking' }); }
  };
  const dlg = openDialog({ title: 'New thread', sub: S().projects[projectId]?.name, body: [h('div.field', h('label.label', { for: 'nt-title' }, 'Title'), title), h('div.field', h('span.label', 'With'), list)],
    foot: [h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button.btn.send', { type: 'button', onclick: create }, 'Start thread')] });
}

// ── Delete confirm ──────────────────────────────────────────────────────────────────────

export function confirmDelete(se) {
  const t = S().threads[se.threadId];
  const items = S().items[se.threadId] ?? [];
  const room = sessionsOf(se.threadId).length > 1;
  const apps = Object.values(S().apps).filter((a) => a.sessionId === se.id).length;
  const blocks = items.filter((i) => i.kind === 'block' && i.sessionId === se.id).length;
  const li = (ok, text) => h('li', h(`span.i.i-${ok ? 'check' : 'x'}.i-sm`, { style: { color: ok ? 'var(--good)' : 'var(--alert-ink)' }, 'aria-hidden': 'true' }), h('span', text));
  const dlg = openDialog({
    title: `Delete @${se.handle}’s session?`, sub: `${S().projects[t?.projectId]?.name} · ${t?.title}`, role: 'alertdialog',
    body: [
      h('div.field', h('span.label', 'This erases'), h('ul.what-goes', room
        ? [li(false, `@${se.handle}’s session and its context, including ${plural(se.compactions ?? 0, 'compaction summary', 'compaction summaries')}`), li(false, `${plural(apps, 'app')} it wrote`)]
        : [li(false, `The thread: ${plural(items.length, 'item')}, including ${plural(blocks, 'block')} and ${plural(apps, 'app')}`), li(false, `@${se.handle}’s context for this session`)])),
      h('div.field', h('span.label', 'This stays'), h('ul.what-goes', li(true, `The @${se.handle} persona and its other sessions`),
        room ? li(true, `Its past messages in this room, marked “(deleted)”`) : null, li(true, `Files in ${S().projects[t?.projectId]?.folder ?? 'the project folder'}`))),
      h('p.small.dim', 'You’ll have 10 seconds to undo. To keep the thread but stop the session, archive it instead.'),
    ],
    foot: [h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button.btn', { type: 'button', onclick: () => { dlg.close(); api(`/api/sessions/${se.id}/archive`, {}).then(() => toast({ title: `Archived @${se.handle}’s session` })); } }, 'Archive instead'),
      h('button.btn.danger', { type: 'button', onclick: async () => {
        dlg.close();
        try {
          const r = await api(`/api/sessions/${se.id}`, undefined, 'DELETE');
          const { afterDelete } = await import('./shell.mjs');
          afterDelete(se, r.until);
          if (location.hash.includes(se.threadId) && !room) navigate('#/');
        } catch (e) { toast({ title: 'Couldn’t delete', text: e.message, level: 'blocking' }); }
      } }, icon('trash', 'i-sm'), 'Delete session')],
    initialFocus: () => null,
  });
  dlg.dialog.querySelector('.d-foot .btn')?.focus();
}

// ── Settings ────────────────────────────────────────────────────────────────────────────

export function openSettings(tab = 'appearance', personaId = null) {
  let cur = tab;
  const tabs = h('div.tabs', { role: 'tablist' });
  const panel = h('div', { role: 'tabpanel', style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  const paint = () => {
    tabs.replaceChildren(...[['appearance', 'Appearance'], ['personas', 'Personas'], ['projects', 'Projects'], ['connect', 'Connect an agent']].map(([id, label]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(cur === id), onclick: () => { cur = id; paint(); } }, label)));
    fill(panel, ...({ appearance, personas, projects, connect })[cur]());
  };
  const appearance = () => {
    const pref = S().settings.theme ?? 'system';
    return [h('div.field', h('span.label', 'Mode'), h('div.seg', { role: 'radiogroup', 'aria-label': 'Mode' }, [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) =>
      h('button', { type: 'button', role: 'radio', 'aria-pressed': String(pref === v), onclick: () => api('/api/settings', { theme: v }, 'PUT').then(paint) }, l)))),
      h('p.small.dim', 'System follows your computer’s setting. The choice is saved in Postbox, so it follows you to other browsers.')];
  };
  const personas = () => {
    const list = Object.values(S().personas);
    const editing = personaId && S().personas[personaId];
    if (editing) return personaForm(editing, () => { personaId = null; paint(); });
    return [h('ul.list-rows', list.map((p) => h('li', h('b', `@${p.handle}`), h('span.small.dim.grow', p.retired ? 'Retired' : p.description),
      h('span.small.dim', `v${p.version ?? 1}`), h('button.btn.sm', { type: 'button', onclick: () => { personaId = p.id; paint(); } }, 'Edit')))),
      h('div.row-flex', h('button.btn', { type: 'button', onclick: () => { dlg.close(); openNewAgent({}); } }, icon('plus'), 'New agent')),
      h('p.small.dim', 'Edits apply to new sessions. Running sessions keep the version they started with.')];
  };
  const personaForm = (p, back) => {
    const tools = new Set(p.tools);
    const desc = h('input.input', { id: 'pe-d', value: p.description });
    const ins = h('textarea.textarea', { id: 'pe-i', style: { minHeight: '100px' } }, p.instructions);
    return [h('button.btn.sm.ghost', { type: 'button', onclick: back, style: { alignSelf: 'flex-start' } }, icon('back', 'i-sm'), 'All personas'), h('b', `@${p.handle}`),
      h('div.field', h('label.label', { for: 'pe-d' }, 'What it does'), desc), h('div.field', h('label.label', { for: 'pe-i' }, 'Instructions'), ins),
      h('div.field', h('span.label', 'Tools'), h('div.chips', (client.config.knownTools ?? []).map(([id]) => h('button.chip.sm', { type: 'button', 'aria-pressed': String(tools.has(id)), class: tools.has(id) ? 'on' : '',
        onclick: (e) => { if (tools.has(id)) tools.delete(id); else tools.add(id); e.currentTarget.classList.toggle('on'); e.currentTarget.setAttribute('aria-pressed', String(tools.has(id))); } }, id)))),
      h('div.row-flex', h('button.btn.send', { type: 'button', onclick: () => api(`/api/personas/${p.id}`, { description: desc.value, instructions: ins.value, tools: [...tools] }, 'PATCH').then(() => { toast({ title: `Saved @${p.handle}`, text: 'New sessions use this version.' }); back(); }).catch((e) => toast({ title: 'Couldn’t save', text: e.message, level: 'blocking' })) }, 'Save'),
        h('button.btn', { type: 'button', onclick: () => api(`/api/personas/${p.id}`, { retired: !p.retired }, 'PATCH').then(back) }, p.retired ? 'Bring back' : 'Retire'))];
  };
  const projects = () => {
    const name = h('input.input', { id: 'pj-n', placeholder: 'Project name' });
    const folder = h('input.input', { id: 'pj-f', placeholder: '/Users/you/Documents/project' });
    return [h('ul.list-rows', Object.values(S().projects).map((p) => h('li', icon('folder', 'dim'), h('b', p.name), h('span.small.dim.mono.grow', p.folder)))),
      h('div.form-grid', h('div.field', h('label.label', { for: 'pj-n' }, 'Name'), name), h('div.field', h('label.label', { for: 'pj-f' }, 'Root folder'), folder)),
      h('div.row-flex', h('button.btn', { type: 'button', onclick: () => api('/api/projects', { name: name.value, folder: folder.value }).then(() => { toast({ title: `Created ${name.value || 'the project'}` }); paint(); }).catch((e) => toast({ title: 'Couldn’t create the project', text: e.message, level: 'blocking' })) }, icon('plus'), 'Create project')),
      h('p.small.dim', 'The folder bounds the file picker and is where Claude Code sessions start.')];
  };
  const connect = () => [
    h('p', 'Real agents reach Postbox’s UI tools over MCP. Stage 3 adds adapters that connect them automatically; until then, every agent runs on the mock.'),
    h('dl.facts', h('dt', 'MCP endpoint'), h('dd.mono', `${client.config.origin}/mcp?session=<session id>`), h('dt', 'Adapters'), h('dd', client.config.adapters.join(', ')), h('dt', 'Corpus'), h('dd', `${plural(client.config.corpus.passages, 'passage')} in ${plural(client.config.corpus.books.length, 'book')}`)),
  ];
  paint();
  const dlg = openDialog({ title: 'Settings', size: 'lg', body: [tabs, panel] });
}

// ── Command palette ─────────────────────────────────────────────────────────────────────

export function openPalette() {
  const input = h('input.input', { 'aria-label': 'Jump to a thread, project, agent or action', placeholder: 'Jump to a thread, an agent, or an action…', role: 'combobox', 'aria-controls': 'p-list', 'aria-expanded': 'true', autocomplete: 'off' });
  const list = h('ul.p-list', { id: 'p-list', role: 'listbox' });
  let sel = 0;
  const all = () => [
    ...Object.values(S().threads).filter((t) => t.kind !== 'side' && !t.archived).map((t) => ({ label: t.title, sub: `${S().projects[t.projectId]?.name} · ${sessionsOf(t.id).map((s) => '@' + s.handle).join(', ')}`, icon: 'thread', run: () => navigate(`#/t/${t.id}`) })),
    { label: 'Overview', sub: 'All live sessions', icon: 'agent', run: () => navigate('#/') },
    { label: 'New agent', sub: 'From a boilerplate', icon: 'plus', run: () => openNewAgent({}) },
    { label: 'Settings', sub: 'Mode, personas, projects', icon: 'gear', run: () => openSettings() },
    ...['system', 'light', 'dark'].map((m) => ({ label: `Switch to ${m === 'system' ? 'the system mode' : m + ' mode'}`, sub: 'Appearance', icon: 'moon', run: () => api('/api/settings', { theme: m }, 'PUT') })),
  ];
  const paint = () => {
    const q = input.value.toLowerCase().trim();
    const items = all().filter((x) => !q || `${x.label} ${x.sub}`.toLowerCase().includes(q)).slice(0, 12);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((x, i) => h('li', { role: 'option', id: `p-${i}`, 'aria-selected': String(i === sel), onclick: () => { dlg.close(); x.run(); } }, icon(x.icon, 'dim'), h('span.grow', x.label, h('span.small.dim', { style: { display: 'block' } }, x.sub)))));
    input.setAttribute('aria-activedescendant', `p-${sel}`);
    return items;
  };
  input.addEventListener('input', () => { sel = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    const items = paint();
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; paint(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; paint(); }
    if (e.key === 'Enter' && items[sel]) { e.preventDefault(); dlg.close(); items[sel].run(); }
  });
  paint();
  const dlg = openDialog({ title: 'Jump to…', body: [input, list], size: 'palette', initialFocus: () => input });
}

// ── Folder picker ───────────────────────────────────────────────────────────────────────

export function openFolderPicker(projectId, onPick) {
  const listEl = h('ul.list-rows');
  const where = h('p.small.dim.mono');
  const load = async (path) => {
    try {
      const r = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(path)}`).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      where.textContent = `${r.root}${r.path ? '/' + r.path : ''}`;
      fill(listEl, 
        r.path ? h('li', h('button.btn.sm.ghost', { type: 'button', onclick: () => load(r.path.split('/').slice(0, -1).join('/')) }, icon('back', 'i-sm'), 'Up')) : null,
        ...r.entries.map((e) => h('li', icon(e.dir ? 'folder' : 'file', 'dim'), h('span.grow', e.name), e.dir ? h('button.btn.sm', { type: 'button', onclick: () => load(e.path) }, 'Open')
          : h('button.btn.sm', { type: 'button', onclick: () => { dlg.close(); onPick(e.path); } }, 'Attach'))),
        r.entries.length ? null : h('li.empty-note', 'This folder is empty.'));
    } catch (e) { listEl.replaceChildren(h('li.err', e.message)); }
  };
  load('');
  const dlg = openDialog({ title: 'Attach from the project folder', sub: 'Postbox attaches a reference; nothing is copied.', body: [where, listEl], size: 'lg' });
}
