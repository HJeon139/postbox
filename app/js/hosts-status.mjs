// A host’s status on its card in the Hosts tab (app/js/hosts.mjs): its connection in words, when Postbox last heard
// from it, what to do about a failure (the command to run in a terminal, Reconnect, Install, Take over), and what
// its daemon found there, with its warnings.

import { api, client } from './client.mjs';
import { ago, fill, h, icon } from './dom.mjs';
import { confirmInstall, confirmTakeover } from './hosts-confirm.mjs';
import { openEditor } from './hosts-editor.mjs';
import { command, commandsIn, withCode } from './hosts-parts.mjs';
import { keepFocus, say, toast } from './ui.mjs';

const S = () => client.state;

/** How each connection state reads; the text says it, never the color alone. */
const STATES = {
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  failed: 'Failed',
  'not-installed': 'Not installed',
};

/** The harnesses a host’s daemon looks for, with the setting that names each one’s path. */
const HARNESSES = {
  'claude-code': ['Claude Code', 'claudePath'],
  'kiro-cli': ['Kiro CLI', 'kiroPath'],
  codex: ['Codex', 'codexPath'],
};

/** Repaints one host’s status, leaving its editor alone. @param {import('./hosts.mjs').Panel} p @param {string} id */
export const paintStatus = (p, id) => {
  const el = p.root.querySelector(`[data-status="${CSS.escape(id)}"]`);
  const host = S().hosts?.[id];
  if (!el || !host) return;
  keepFocus(/** @type {HTMLElement} */ (el), () => fill(/** @type {HTMLElement} */ (el), ...statusView(p, host)));
};

/** @param {import('./hosts.mjs').Panel} p @param {any} host */
export const statusView = (p, host) => {
  const st = S().hostStatus?.[host.id] ?? null;
  const state = st?.state ?? null;
  const heard = st?.lastHeard ? `Last heard from ${ago(st.lastHeard)}` : 'Not heard from yet';
  return [
    h(
      'div.row-flex.wrap',
      { style: { gap: '8px' } },
      h(`span.status-tag${state === 'connected' ? '.ok' : ''}`, state === 'failed' ? icon('warn', 'i-sm') : null, STATES[state] ?? 'Not connected yet'),
      h('span.small.dim', heard),
    ),
    st?.failure && state !== 'connected' ? failureView(p, host, st.failure) : stateNote(host, state),
    st?.welcome ? welcomeView(host, st.welcome) : null,
  ];
};

/** What a state without a failure means, and the action it takes. @param {any} host @param {string|null} state */
const stateNote = (host, state) => {
  if (state === 'not-installed')
    return h(
      'div.callout.warn',
      icon('warn'),
      h(
        'div.grow',
        h('p', { style: { margin: 0 } }, `Postbox’s host program isn’t installed on ${host.name} yet. Install it before an agent runs there.`),
        h('div.row-flex.wrap', { style: { marginTop: '8px' } }, installButton(host, 'Install…')),
      ),
    );
  if (state === 'reconnecting')
    return h(
      'div.row-flex.wrap',
      h('p.small', { style: { margin: 0 } }, 'Postbox is connecting, and tries again on its own while a turn runs or a prompt waits.'),
      retryButton(host, 'Retry now'),
    );
  if (state === 'disconnected' || !state) return h('p.small.dim', { style: { margin: 0 } }, 'Postbox connects when an agent’s turn there needs it.');
  return null;
};

/** @param {import('./hosts.mjs').Panel} p @param {any} host @param {{ kind: string, message: string, next: string|null }} f */
const failureView = (p, host, f) => {
  const actions = [];
  // What only you can fix in a terminal: the command to run there, then reconnect.
  const commands = f.kind === 'sign-in' || f.kind === 'host-key' ? commandsIn(f.next) : [];
  if (f.kind === 'sign-in' || f.kind === 'host-key') actions.push(retryButton(host, 'Reconnect'));
  else if (f.kind === 'not-installed' || f.kind === 'version') actions.push(installButton(host, 'Install…'));
  else if (f.kind === 'bad-token') actions.push(installButton(host, 'Reinstall…'));
  else if (f.kind === 'no-node')
    actions.push(
      h('button.btn.sm', { type: 'button', id: `ho-${host.id}-set-node`, onclick: () => openEditor(p, host, 'nodePath') }, 'Set Node’s path'),
      retryButton(host, 'Reconnect'),
    );
  else if (f.kind === 'busy')
    actions.push(h('button.btn.sm', { type: 'button', id: `ho-${host.id}-takeover`, onclick: () => confirmTakeover(host) }, 'Take over…'));
  else actions.push(retryButton(host, 'Retry now'));
  return h(
    'div.callout.ho-failure',
    { dataset: { kind: f.kind } },
    icon('warn'),
    h(
      'div.grow',
      { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
      h('b', { style: { overflowWrap: 'anywhere' } }, f.message),
      f.next ? h('p', { style: { margin: 0, overflowWrap: 'anywhere' } }, withCode(f.next)) : null,
      commands.length
        ? h('p.small.dim', { style: { margin: 0 } }, commands.length === 1 ? 'Run this in a terminal:' : 'Run these in a terminal, in order:')
        : null,
      commands.map(command),
      h('div.row-flex.wrap', actions),
    ),
  );
};

/** What the host’s daemon found there, and what it warns about. @param {any} host @param {any} w */
const welcomeView = (host, w) => {
  const facts = [h('dt', 'Node'), h('dd', w.node ? `${w.node.version} at ${w.node.path}` : 'Not reported')];
  for (const [name, [label]] of Object.entries(HARNESSES)) {
    const x = (w.harnesses ?? []).find((/** @type {any} */ y) => y.name === name);
    facts.push(
      h('dt', label),
      h(
        'dd',
        { style: { overflowWrap: 'anywhere' } },
        x?.path
          ? `${x.version ?? 'Version unknown'} at ${x.path}`
          : `Not found${x?.looked?.length ? `. The daemon looked in ${x.looked.join(', ')}` : ''}. Install it there, or set its path in this host’s settings.`,
      ),
    );
  }
  return [
    h('dl.facts.ho-found', { 'aria-label': `What Postbox found on ${host.name}` }, facts),
    (w.problems ?? []).map((/** @type {{ code: string, message: string }} */ p) => problemView(host, p)),
  ];
};

/** @param {any} host @param {{ code: string, message: string }} p */
const problemView = (host, p) =>
  h(
    'div.callout.warn.ho-problem',
    { dataset: { code: p.code } },
    icon('warn'),
    p.code === 'no-linger'
      ? h(
          'div.grow',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
          h('b', `Turns on ${host.name} end when your last session there does`),
          h(
            'p',
            { style: { margin: 0 } },
            `Lingering is off for your user on ${host.name}, so systemd ends its turns when you log out of your last session there. To keep them running, turn lingering on: run this on ${host.name}.`,
          ),
          command('loginctl enable-linger'),
        )
      : h('p.grow', { style: { margin: 0, overflowWrap: 'anywhere' } }, p.message),
  );

/** @param {any} host @param {string} label */
const retryButton = (host, label) =>
  h(
    'button.btn.sm',
    {
      type: 'button',
      id: `ho-${host.id}-retry`,
      onclick: () =>
        api(`/api/hosts/${host.id}/retry`, { takeover: false })
          .then(() => say(`Connecting to ${host.name}`))
          .catch((e) => toast({ title: `Couldn’t connect to ${host.name}`, text: [e.message, e.next].filter(Boolean).join(' '), level: 'blocking' })),
    },
    icon('retry', 'i-sm'),
    label,
  );

/** @param {any} host @param {string} label */
const installButton = (host, label) => h('button.btn.sm.send', { type: 'button', id: `ho-${host.id}-install`, onclick: () => confirmInstall(host) }, label);
