// Remote hosts in Settings (#120): the hosts agents can run on, each with its connection’s status, what to do about a
// failure, what its daemon found there, its settings (the design’s table, shared/remote-settings.mjs) and each
// project’s folder there. Installing Postbox there, taking a host over from another Postbox and removing a host each
// ask first. The checks are the server’s own, from shared/remote-settings.mjs, so a refusal here reads as the
// server’s would; the server checks again where the input enters.
//
// The tab is one panel (Panel, below) that the parts it’s built from take first: the status in hosts-status.mjs, the
// editor in hosts-editor.mjs and its fields in hosts-fields.mjs, the settings’ table in hosts-settings.mjs, and what
// it asks first in hosts-confirm.mjs.

import { checkDestination } from '/shared/remote-settings.mjs';
import { api, client } from './client.mjs';
import { fill, h, icon } from './dom.mjs';
import { confirmRemove } from './hosts-confirm.mjs';
import { editor, openEditor } from './hosts-editor.mjs';
import { paintStatus, statusView } from './hosts-status.mjs';
import { keepFocus, toast } from './ui.mjs';

const S = () => client.state;

/**
 * The Hosts tab’s state, kept across repaints: the host being edited and the editor’s values (draft), each field’s
 * error, the form’s, whether it’s saving, the Add a host field, and the host just added, whose Install… gets focus.
 * @typedef {{ name: string, v: Record<string, any>, folders: Record<string, string> }} Draft
 * @typedef {{ root: HTMLElement, editing: string | null, draft: Draft | null, errors: Record<string, string>, formError: string,
 *   saving: boolean, addName: string, addError: string, added: string | null, paint: () => void }} Panel
 */

/**
 * The Hosts tab of Settings: one element that keeps itself current, so a host’s status changes while you look.
 * @returns {HTMLElement}
 */
export function hostsPanel() {
  const root = h('div.hosts', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } });
  /** @type {Panel} */
  const p = {
    root,
    editing: null,
    draft: null,
    errors: {},
    formError: '',
    saving: false,
    addName: '',
    addError: '',
    added: null,
    paint: () => keepFocus(root, () => fill(root, ...view(p))),
  };
  listen(p);
  p.paint();
  return root;
}

/** Live while it’s on the page; it stops listening once it’s gone (another tab, or Settings closed). @param {Panel} p */
function listen(p) {
  let seen = false;
  const off = client.on((ch) => {
    if (!p.root.isConnected) {
      if (seen) stop();
      return;
    }
    seen = true;
    if (ch.type === 'host.status') paintStatus(p, ch.data?.id);
    else if (['host', 'project', 'persona', 'load'].includes(ch.type)) p.paint();
    focusAdded(p);
  });
  // “Last heard from” moves on with the clock.
  const tick = setInterval(() => {
    if (!p.root.isConnected) {
      if (seen) stop();
      return;
    }
    seen = true;
    for (const id of Object.keys(S().hosts ?? {})) paintStatus(p, id);
  }, 30_000);
  const stop = () => {
    off();
    clearInterval(tick);
  };
}

const hosts = () => Object.values(S().hosts ?? {}).sort((a, b) => a.createdAt - b.createdAt);

/** @param {Panel} p */
const view = (p) => {
  const list = hosts();
  return [
    h('p.small.dim', 'Agents can run on another computer you reach with ssh, while Postbox stays here. Pick a host for an agent in its settings.'),
    list.length ? list.map((host) => hostCard(p, host)) : h('p.empty-note', 'No hosts yet.'),
    addForm(p),
  ];
};

/** @param {Panel} p @param {any} host */
const hostCard = (p, host) => {
  const id = host.id;
  const titleId = `ho-${id}-t`;
  return h(
    'section.block.ho-card',
    { 'aria-labelledby': titleId, dataset: { host: id } },
    h(
      'div',
      { style: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('h3.mono', { id: titleId, style: { margin: 0, fontSize: '14px', overflowWrap: 'anywhere' } }, host.name),
      h('div', { dataset: { status: id }, style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, statusView(p, host)),
      p.editing === id
        ? editor(p, host)
        : h(
            'div.row-flex.wrap',
            h(
              'button.btn.sm',
              {
                type: 'button',
                id: `ho-${id}-edit`,
                'aria-label': `Edit settings for ${host.name}`,
                onclick: () => openEditor(p, host),
              },
              icon('edit', 'i-sm'),
              'Edit settings',
            ),
            h(
              'button.btn.sm.danger',
              { type: 'button', id: `ho-${id}-remove`, 'aria-label': `Remove ${host.name}`, onclick: () => confirmRemove(host) },
              icon('trash', 'i-sm'),
              'Remove…',
            ),
          ),
    ),
  );
};

// ── Adding ──

/** @param {Panel} p */
const addForm = (p) => {
  const input = h('input.input.mono', {
    id: 'ho-add',
    value: p.addName,
    placeholder: 'user@host.example.com',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-describedby': 'ho-add-help',
    'aria-errormessage': 'ho-add-err',
    'aria-invalid': p.addError ? 'true' : null,
    oninput: (e) => {
      p.addName = e.target.value;
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') add(p);
    },
  });
  return h(
    'section.ho-add',
    { 'aria-labelledby': 'ho-add-h', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    h('h3.label', { id: 'ho-add-h', style: { margin: 0 } }, 'Add a host'),
    h(
      'div.field',
      h('label.label', { for: 'ho-add' }, 'SSH destination'),
      input,
      h('span.err', { id: 'ho-add-err', role: 'alert', hidden: !p.addError }, p.addError),
      h(
        'span.help',
        { id: 'ho-add-help' },
        'An alias from your ~/.ssh/config, a host name, or user@host. Postbox runs your own ssh, so your config’s ProxyJump, certificates and known hosts apply.',
      ),
    ),
    h('div.row-flex', h('button.btn', { type: 'button', id: 'ho-add-btn', onclick: () => add(p) }, icon('plus'), 'Add host')),
  );
};

/** @param {Panel} p */
const add = (p) => {
  const r = checkDestination(p.addName);
  if (!r.ok) {
    p.addError = r.error;
    p.paint();
    document.getElementById('ho-add')?.focus();
    return;
  }
  api('/api/hosts', { name: r.value })
    .then((made) => {
      p.addName = '';
      p.addError = '';
      toast({ title: `Added ${made.name}`, text: 'Install Postbox there before an agent runs on it.' });
      p.added = made.id;
      p.paint();
      focusAdded(p);
    })
    .catch((e) => {
      p.addError = e.message;
      p.paint();
      document.getElementById('ho-add')?.focus();
    });
};

/**
 * A host just added: its Install… gets focus once its card shows it, since its status can reach the page just after
 * the host does. Not if you’ve moved on from Add a host meanwhile.
 * @param {Panel} p
 */
const focusAdded = (p) => {
  const el = p.added ? document.getElementById(`ho-${p.added}-install`) : null;
  if (!el) return;
  p.added = null;
  const at = document.activeElement;
  if (!at || at === document.body || at.closest('.ho-add')) el.focus();
};
