// Remote hosts in Settings (#120): the hosts agents can run on, each with its connection’s status, what to do about a
// failure, what its daemon found there, its settings (the design’s table, shared/remote-settings.mjs) and each
// project’s folder there. Installing Postbox there, taking a host over from another Postbox and removing a host each
// ask first. The checks are the server’s own, from shared/remote-settings.mjs, so a refusal here reads as the
// server’s would; the server checks again where the input enters.

import { checkDestination, checkHostPath, checkHostSettings, RANGES } from '/shared/remote-settings.mjs';
import { api, client } from './client.mjs';
import { ago, fill, h, icon, plural } from './dom.mjs';
import { keepFocus, openDialog, say, toast } from './ui.mjs';

const S = () => client.state;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;
/** The units a duration is written in, largest last. */
const UNITS = [
  ['min', MINUTE],
  ['h', HOUR],
  ['days', DAY],
];

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

/**
 * @typedef {{ ok: true, value: any } | { ok: false, error: string }} Parsed
 * @typedef {{ key: string, label: string, help: string, kind: 'duration' | 'number' | 'check' | 'path' | 'detach' | 'argv',
 *   unit?: string, scale?: number }} Field
 *   key: the setting, or keepAlive.interval / keepAlive.count; unit and scale: a number’s unit and its size in the
 *   setting’s own unit (milliseconds or bytes).
 */

/** The settings, in the groups the editor shows them in. @type {[string, Field[]][]} */
const GROUPS = [
  [
    'Turns',
    [
      {
        key: 'stallTimeout',
        label: 'Stop a quiet turn after',
        kind: 'duration',
        help: `A turn with no output, no prompt waiting and no tool call open for this long is stopped as hung. ${RANGES.stallTimeout.range}. Raise it when tools or models stay quiet for longer.`,
      },
      {
        key: 'permissionWaitMax',
        label: 'Longest wait for a permission answer',
        kind: 'duration',
        help: `A prompt waits this long on the host for your answer, then it’s denied. ${RANGES.permissionWaitMax.range}.`,
      },
      {
        key: 'denyPrompts',
        label: 'Deny permission prompts instead of waiting (unattended runs)',
        kind: 'check',
        help: 'Claude Code denies what it would ask about, rather than wait for a card nobody may answer (--permission-prompts none, Claude Code 2.1.259 or later). Off by default.',
      },
      {
        key: 'detach',
        label: 'How turns detach',
        kind: 'detach',
        help: 'Each turn runs in its own session, so it goes on when the connection drops, and in a systemd user scope too where logind ends processes at logout. On a host without systemd, choose own session only.',
      },
      {
        key: 'signInCheck',
        label: 'Sign-in check',
        kind: 'argv',
        help: 'A command that exits 0 while the host’s sign-in is good, one argument per line, run without a shell: such as klist on the first line and -s on the second. A turn stopped for its sign-in goes on by itself only when it passes. Empty: no check, and such a turn waits for you.',
      },
    ],
  ],
  [
    'Connection',
    [
      {
        key: 'keepAlive.interval',
        label: 'Keepalive every',
        kind: 'number',
        unit: 's',
        scale: SECOND,
        help: `${RANGES['keepAlive.interval'].range}. ssh drops a dead connection after about this times the count below: 45 s by default.`,
      },
      {
        key: 'keepAlive.count',
        label: 'Missed keepalives before it drops',
        kind: 'number',
        scale: 1,
        help: `${RANGES['keepAlive.count'].range}. Raise them when the network drops keepalives.`,
      },
      {
        key: 'dedicatedConnection',
        label: 'Use a connection of its own',
        kind: 'check',
        help: 'On, Postbox’s ssh options apply. Off, it shares your multiplexed connection, such as to a jump host you can’t reopen, with that connection’s options.',
      },
      {
        key: 'forwardAgent',
        label: 'Forward your ssh agent',
        kind: 'check',
        help: 'Lets turns sign in to other machines with the keys in this computer’s ssh agent. It doesn’t copy your private keys to the host, but while Postbox is connected, any process running as your user there, including the agent and the commands it runs, can use your ssh agent to sign in to other machines. Turn it on only for a host you trust that needs it. Off by default.',
      },
      {
        key: 'idleTimeout',
        label: 'Daemon’s idle time',
        kind: 'duration',
        help: `Postbox’s daemon on the host exits after this long with no turn running and no Postbox connected. ${RANGES.idleTimeout.range}.`,
      },
    ],
  ],
  [
    'Logs',
    [
      {
        key: 'logRetention',
        label: 'Keep turn logs for',
        kind: 'duration',
        help: `A turn’s logs go once Postbox has read all of them, and after this long regardless. ${RANGES.logRetention.range}.`,
      },
      {
        key: 'logMaxBytes',
        label: 'Largest turn log',
        kind: 'number',
        unit: 'MiB',
        scale: MIB,
        help: `${RANGES.logMaxBytes.range}. Lower it when the host is short of disk.`,
      },
    ],
  ],
  [
    'Programs',
    [
      { key: 'nodePath', label: 'Node’s path', kind: 'path', help: '' },
      { key: 'claudePath', label: 'Claude Code’s path', kind: 'path', help: '' },
      { key: 'kiroPath', label: 'Kiro CLI’s path', kind: 'path', help: '' },
      { key: 'codexPath', label: 'Codex’s path', kind: 'path', help: '' },
    ],
  ],
];
const FIELDS = GROUPS.flatMap(([, fields]) => fields);
const PROGRAMS_HELP = 'Absolute paths on the host, for installs in unusual places. Empty: the daemon looks on PATH and in the usual install folders.';
const DETACH = [
  ['auto', 'Own session, and a user scope'],
  ['setsid', 'Own session only'],
];

/** A setting’s value, by key; keepAlive’s two by their path. @param {any} s @param {string} key */
const settingOf = (s, key) => (key.startsWith('keepAlive.') ? s.keepAlive?.[key.slice(10)] : s[key]);

/** A duration as the editor writes it: the largest unit it’s a whole number of, else minutes. @param {number} ms */
function splitDuration(ms) {
  for (const [unit, size] of [...UNITS].reverse()) if (ms % size === 0) return { n: String(ms / size), unit };
  return { n: String(Math.round((ms / MINUTE) * 1000) / 1000), unit: 'min' };
}

/** What the editor shows for a setting. @param {Field} f @param {any} s */
function shown(f, s) {
  const v = settingOf(s, f.key);
  if (f.kind === 'duration') return splitDuration(v);
  if (f.kind === 'number') return String(v / (f.scale ?? 1));
  if (f.kind === 'path') return v ?? '';
  if (f.kind === 'argv') return (v ?? []).join('\n');
  return v;
}

/**
 * The setting’s value from what the editor holds, or why it can’t be. Numbers are checked against RANGES here, so the
 * message is in the units you typed; everything is then checked as the server checks it.
 * @param {Field} f @param {any} v @param {any} base  the host’s settings now @returns {Parsed}
 */
function parse(f, v, base) {
  /** @type {any} */
  let value = v;
  if (f.kind === 'duration' || f.kind === 'number') {
    const text = String(f.kind === 'duration' ? v.n : v).trim();
    const n = Number(text);
    if (!text || !Number.isFinite(n)) return { ok: false, error: `${f.label}: write a number.` };
    const size = f.kind === 'duration' ? (UNITS.find(([u]) => u === v.unit)?.[1] ?? MINUTE) : (f.scale ?? 1);
    value = Math.round(n * size);
    const { min, max, step, range } = RANGES[f.key];
    // Durations and the keepalive are kept in whole seconds.
    if (step === SECOND) value = Math.round(value / SECOND) * SECOND;
    if (value < min || value > max || (step === 1 && !Number.isInteger(n * (f.scale ?? 1)))) return { ok: false, error: `${f.label} must be ${range}.` };
  } else if (f.kind === 'path') {
    const text = String(v).trim();
    if (!text) value = null;
    else {
      const r = checkHostPath(text, f.label);
      if (!r.ok) return r;
      value = r.value;
    }
  } else if (f.kind === 'argv') {
    const lines = String(v)
      .replace(/\r/g, '')
      .split('\n')
      .filter((l) => l.trim());
    value = lines.length ? lines : null;
  }
  const patch = f.key.startsWith('keepAlive.') ? { keepAlive: { [f.key.slice(10)]: value } } : { [f.key]: value };
  const r = checkHostSettings(patch, base);
  return r.ok ? { ok: true, value } : r;
}

/** Text with `commands` in it, the commands as code. @param {string} text */
const withCode = (text) =>
  String(text ?? '')
    .split('`')
    .map((part, i) => (i % 2 ? h('code', part) : part));
/** The `commands` in a next step, to copy. @param {string} text */
const commandsIn = (text) =>
  String(text ?? '')
    .split('`')
    .filter((_, i) => i % 2)
    .filter(Boolean);

/** A button that copies a command, saying so. @param {string} text */
function copyButton(text) {
  const label = h('span', 'Copy');
  return h(
    'button.btn.sm',
    {
      type: 'button',
      'aria-label': `Copy ${text}`,
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          label.textContent = 'Copied';
          say(`Copied ${text}`);
        } catch {
          toast({ title: 'Couldn’t copy it', text: `Select the command and copy it: ${text}` });
        }
        setTimeout(() => {
          label.textContent = 'Copy';
        }, 2000);
      },
    },
    icon('copy', 'i-sm'),
    label,
  );
}

/** A command to run in a terminal, with its Copy button. @param {string} cmd */
const command = (cmd) =>
  h(
    'div.row-flex.wrap.ho-cmd',
    { style: { gap: '8px' } },
    h('code', { style: { overflowWrap: 'anywhere', padding: '4px 8px', background: 'var(--sunk)', borderRadius: '4px' } }, cmd),
    copyButton(cmd),
  );

/** A labeled checkbox with help text under it, as the persona sheet’s (sheets.mjs). */
function checkField({ id, label, help, on, onToggle }) {
  return h(
    'div.field.span',
    h(
      'span.check',
      {
        id,
        role: 'checkbox',
        tabindex: '0',
        'aria-checked': String(on),
        'aria-describedby': `${id}-help`,
        style: { alignSelf: 'flex-start' },
        onclick: (e) => {
          on = !on;
          e.currentTarget.setAttribute('aria-checked', String(on));
          onToggle(on);
        },
        onkeydown: (e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.click();
          }
        },
      },
      h('span.box'),
      h('span', label),
    ),
    h('span.help', { id: `${id}-help` }, help),
  );
}

/** Shows or clears a field’s error in place, beside its control. @param {HTMLElement | null} err @param {string} text */
function showError(err, text) {
  if (!err) return;
  err.textContent = text;
  err.hidden = !text;
  const control = document.querySelector(`[aria-errormessage="${err.id}"]`);
  if (text) control?.setAttribute('aria-invalid', 'true');
  else control?.removeAttribute('aria-invalid');
}

/**
 * The Hosts tab of Settings: one element that keeps itself current, so a host’s status changes while you look.
 * @returns {HTMLElement}
 */
export function hostsPanel() {
  const root = h('div.hosts', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } });
  /** The host being edited, and the editor’s values, kept across repaints. @type {string | null} */
  let editing = null;
  /** @type {{ name: string, v: Record<string, any>, folders: Record<string, string> } | null} */
  let draft = null;
  /** @type {Record<string, string>} */
  let errors = {};
  let formError = '';
  let saving = false;
  let addName = '';
  let addError = '';

  const paint = () => keepFocus(root, () => fill(root, ...view()));
  /** Repaints one host’s status, leaving its editor alone. @param {string} id */
  const paintStatus = (id) => {
    const el = root.querySelector(`[data-status="${CSS.escape(id)}"]`);
    const host = S().hosts?.[id];
    if (!el || !host) return;
    keepFocus(/** @type {HTMLElement} */ (el), () => fill(/** @type {HTMLElement} */ (el), ...statusView(host)));
  };

  // Live while it’s on the page; it stops listening once it’s gone (another tab, or Settings closed).
  let seen = false;
  const off = client.on((ch) => {
    if (!root.isConnected) {
      if (seen) stop();
      return;
    }
    seen = true;
    if (ch.type === 'host.status') paintStatus(ch.data?.id);
    else if (['host', 'project', 'persona', 'load'].includes(ch.type)) paint();
  });
  // “Last heard from” moves on with the clock.
  const tick = setInterval(() => {
    if (!root.isConnected) {
      if (seen) stop();
      return;
    }
    seen = true;
    for (const id of Object.keys(S().hosts ?? {})) paintStatus(id);
  }, 30_000);
  const stop = () => {
    off();
    clearInterval(tick);
  };

  const hosts = () => Object.values(S().hosts ?? {}).sort((a, b) => a.createdAt - b.createdAt);

  const view = () => {
    const list = hosts();
    return [
      h('p.small.dim', 'Agents can run on another computer you reach with ssh, while Postbox stays here. Pick a host for an agent in its settings.'),
      list.length ? list.map((host) => hostCard(host)) : h('p.empty-note', 'No hosts yet.'),
      addForm(),
    ];
  };

  /** @param {any} host */
  const hostCard = (host) => {
    const id = host.id;
    const titleId = `ho-${id}-t`;
    return h(
      'section.block.ho-card',
      { 'aria-labelledby': titleId, dataset: { host: id } },
      h(
        'div',
        { style: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('h3.mono', { id: titleId, style: { margin: 0, fontSize: '14px', overflowWrap: 'anywhere' } }, host.name),
        h('div', { dataset: { status: id }, style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, statusView(host)),
        editing === id
          ? editor(host)
          : h(
              'div.row-flex.wrap',
              h(
                'button.btn.sm',
                {
                  type: 'button',
                  id: `ho-${id}-edit`,
                  'aria-label': `Edit settings for ${host.name}`,
                  onclick: () => openEditor(host),
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

  /** @param {any} host @param {string} [focus]  a setting whose field gets focus */
  const openEditor = (host, focus) => {
    editing = host.id;
    errors = {};
    formError = '';
    draft = { name: host.name, v: {}, folders: {} };
    for (const f of FIELDS) draft.v[f.key] = shown(f, host.settings);
    for (const p of Object.values(S().projects)) draft.folders[p.id] = p.hostFolders?.[host.id] ?? '';
    paint();
    document.getElementById(`ho-${host.id}-${focus ?? 'name'}`)?.focus();
  };
  const closeEditor = () => {
    const id = editing;
    editing = null;
    draft = null;
    paint();
    if (id) document.getElementById(`ho-${id}-edit`)?.focus();
  };

  // ── Status ──

  /** @param {any} host */
  const statusView = (host) => {
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
      st?.failure && state !== 'connected' ? failureView(host, st.failure) : stateNote(host, state),
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

  /** @param {any} host @param {{ kind: string, message: string, next: string|null }} f */
  const failureView = (host, f) => {
    const actions = [];
    // What only you can fix in a terminal: the command to run there, then reconnect.
    const commands = f.kind === 'sign-in' || f.kind === 'host-key' ? commandsIn(f.next) : [];
    if (f.kind === 'sign-in' || f.kind === 'host-key') actions.push(retryButton(host, 'Reconnect'));
    else if (f.kind === 'not-installed' || f.kind === 'version') actions.push(installButton(host, 'Install…'));
    else if (f.kind === 'bad-token') actions.push(installButton(host, 'Reinstall…'));
    else if (f.kind === 'no-node')
      actions.push(
        h('button.btn.sm', { type: 'button', id: `ho-${host.id}-set-node`, onclick: () => openEditor(host, 'nodePath') }, 'Set Node’s path'),
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

  // ── Adding ──

  const addForm = () => {
    const input = h('input.input.mono', {
      id: 'ho-add',
      value: addName,
      placeholder: 'user@host.example.com',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-describedby': 'ho-add-help',
      'aria-errormessage': 'ho-add-err',
      'aria-invalid': addError ? 'true' : null,
      oninput: (e) => {
        addName = e.target.value;
      },
      onkeydown: (e) => {
        if (e.key === 'Enter') add();
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
        h('span.err', { id: 'ho-add-err', role: 'alert', hidden: !addError }, addError),
        h(
          'span.help',
          { id: 'ho-add-help' },
          'An alias from your ~/.ssh/config, a host name, or user@host. Postbox runs your own ssh, so your config’s ProxyJump, certificates and known hosts apply.',
        ),
      ),
      h('div.row-flex', h('button.btn', { type: 'button', id: 'ho-add-btn', onclick: () => add() }, icon('plus'), 'Add host')),
    );
  };

  const add = () => {
    const r = checkDestination(addName);
    if (!r.ok) {
      addError = r.error;
      paint();
      document.getElementById('ho-add')?.focus();
      return;
    }
    api('/api/hosts', { name: r.value })
      .then((made) => {
        addName = '';
        addError = '';
        toast({ title: `Added ${made.name}`, text: 'Install Postbox there before an agent runs on it.' });
        paint();
        document.getElementById(`ho-${made.id}-install`)?.focus();
      })
      .catch((e) => {
        addError = e.message;
        paint();
        document.getElementById('ho-add')?.focus();
      });
  };

  // ── Editing ──

  /** @param {any} host */
  const editor = (host) => {
    const id = host.id;
    const d = /** @type {NonNullable<typeof draft>} */ (draft);
    const fid = (/** @type {string} */ key) => `ho-${id}-${key.replace('.', '-')}`;
    /** The error under a field, shown or hidden. @param {string} key */
    const errEl = (key) => h('span.err', { id: `${fid(key)}-err`, hidden: !errors[key] }, errors[key] ?? '');
    /** Checks one field as you leave it. @param {Field} f */
    const recheck = (f) => {
      const r = parse(f, d.v[f.key], host.settings);
      errors[f.key] = r.ok ? '' : r.error;
      showError(document.getElementById(`${fid(f.key)}-err`), errors[f.key]);
    };
    /** @param {Field} f */
    const field = (f) => {
      const cid = fid(f.key);
      const described = [`${cid}-help`, `${cid}-err`].join(' ');
      if (f.kind === 'check')
        return checkField({
          id: cid,
          label: f.label,
          help: f.help,
          on: d.v[f.key] === true,
          onToggle: (on) => {
            d.v[f.key] = on;
          },
        });
      if (f.kind === 'duration')
        return h(
          'div.field',
          h('label.label', { for: cid }, f.label),
          h(
            'div.row-flex',
            { style: { gap: '6px' } },
            h('input.input', {
              id: cid,
              type: 'number',
              min: '0',
              step: 'any',
              inputmode: 'decimal',
              value: d.v[f.key].n,
              style: { maxWidth: '120px' },
              'aria-describedby': described,
              'aria-errormessage': `${cid}-err`,
              'aria-invalid': errors[f.key] ? 'true' : null,
              oninput: (e) => {
                d.v[f.key] = { ...d.v[f.key], n: e.target.value };
              },
              onchange: () => recheck(f),
            }),
            h(
              'div.select-wrap',
              { style: { width: 'auto' } },
              h(
                'select.select',
                {
                  id: `${cid}-unit`,
                  'aria-label': `${f.label}, unit`,
                  onchange: (e) => {
                    d.v[f.key] = { ...d.v[f.key], unit: e.target.value };
                    recheck(f);
                  },
                },
                UNITS.map(([u]) => h('option', { value: u, selected: d.v[f.key].unit === u }, u)),
              ),
              icon('down'),
            ),
          ),
          errEl(f.key),
          h('span.help', { id: `${cid}-help` }, f.help),
        );
      if (f.kind === 'number')
        return h(
          'div.field',
          h('label.label', { for: cid }, f.unit ? `${f.label} (${f.unit})` : f.label),
          h('input.input', {
            id: cid,
            type: 'number',
            min: '0',
            step: 'any',
            inputmode: 'decimal',
            value: d.v[f.key],
            style: { maxWidth: '120px' },
            'aria-describedby': described,
            'aria-errormessage': `${cid}-err`,
            'aria-invalid': errors[f.key] ? 'true' : null,
            oninput: (e) => {
              d.v[f.key] = e.target.value;
            },
            onchange: () => recheck(f),
          }),
          errEl(f.key),
          h('span.help', { id: `${cid}-help` }, f.help),
        );
      if (f.kind === 'detach')
        return h(
          'div.field.span',
          h('label.label', { for: cid }, f.label),
          h(
            'div.select-wrap',
            h(
              'select.select',
              {
                id: cid,
                'aria-describedby': `${cid}-help`,
                onchange: (e) => {
                  d.v[f.key] = e.target.value;
                },
              },
              DETACH.map(([v, label]) => h('option', { value: v, selected: d.v[f.key] === v }, label)),
            ),
            icon('down'),
          ),
          h('span.help', { id: `${cid}-help` }, f.help),
        );
      if (f.kind === 'argv')
        return h(
          'div.field.span',
          h('label.label', { for: cid }, f.label),
          h('textarea.textarea.mono', {
            id: cid,
            rows: '3',
            spellcheck: 'false',
            placeholder: 'klist\n-s',
            value: d.v[f.key],
            'aria-describedby': described,
            'aria-errormessage': `${cid}-err`,
            'aria-invalid': errors[f.key] ? 'true' : null,
            oninput: (e) => {
              d.v[f.key] = e.target.value;
            },
            onchange: () => recheck(f),
          }),
          errEl(f.key),
          h('span.help', { id: `${cid}-help` }, f.help),
        );
      // A path on the host.
      return h(
        'div.field.span',
        h('label.label', { for: cid }, f.label),
        h('input.input.mono', {
          id: cid,
          value: d.v[f.key],
          placeholder: 'Found on the host',
          spellcheck: 'false',
          autocomplete: 'off',
          'aria-describedby': `ho-${id}-programs-help ${cid}-err`,
          'aria-errormessage': `${cid}-err`,
          'aria-invalid': errors[f.key] ? 'true' : null,
          oninput: (e) => {
            d.v[f.key] = e.target.value;
          },
          onchange: () => recheck(f),
        }),
        errEl(f.key),
      );
    };
    const projects = Object.values(S().projects);
    const folderLabel = `The project’s folder on ${d.name || host.name}`;
    return h(
      'div.ho-editor',
      { style: { display: 'flex', flexDirection: 'column', gap: '14px', borderTop: '1px solid var(--line)', paddingTop: '12px' } },
      h(
        'div.field',
        h('label.label', { for: fid('name') }, 'SSH destination'),
        h('input.input.mono', {
          id: fid('name'),
          value: d.name,
          spellcheck: 'false',
          autocomplete: 'off',
          'aria-describedby': `${fid('name')}-help ${fid('name')}-err`,
          'aria-errormessage': `${fid('name')}-err`,
          'aria-invalid': errors.name ? 'true' : null,
          oninput: (e) => {
            d.name = e.target.value;
          },
          onchange: () => {
            const r = checkDestination(d.name);
            errors.name = r.ok ? '' : r.error;
            showError(document.getElementById(`${fid('name')}-err`), errors.name);
          },
        }),
        errEl('name'),
        h('span.help', { id: `${fid('name')}-help` }, 'Renaming it points it at another machine, so it can’t be renamed while turns run there.'),
      ),
      GROUPS.map(([group, fields]) =>
        h(
          'section',
          { 'aria-labelledby': `ho-${id}-g-${group}`, style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('h4.label', { id: `ho-${id}-g-${group}`, style: { margin: 0 } }, group),
          group === 'Programs' ? h('p.help', { id: `ho-${id}-programs-help`, style: { margin: 0 } }, PROGRAMS_HELP) : null,
          h('div.form-grid', fields.map(field)),
        ),
      ),
      h(
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
              projects.map((p) => {
                const cid = `ho-${id}-pf-${p.id}`;
                return h(
                  'div.field.span',
                  h('label.label', { for: cid }, p.name),
                  h('input.input.mono', {
                    id: cid,
                    value: d.folders[p.id] ?? '',
                    placeholder: '/home/you/project',
                    spellcheck: 'false',
                    autocomplete: 'off',
                    'aria-describedby': `ho-${id}-folders-help ${cid}-err`,
                    'aria-errormessage': `${cid}-err`,
                    'aria-invalid': errors[`pf:${p.id}`] ? 'true' : null,
                    oninput: (e) => {
                      d.folders[p.id] = e.target.value;
                    },
                    onchange: () => {
                      const v = d.folders[p.id].trim();
                      const r = v ? checkHostPath(v, folderLabel) : { ok: true };
                      errors[`pf:${p.id}`] = r.ok ? '' : /** @type {any} */ (r).error;
                      showError(document.getElementById(`${cid}-err`), errors[`pf:${p.id}`]);
                    },
                  }),
                  h('span.err', { id: `${cid}-err`, hidden: !errors[`pf:${p.id}`] }, errors[`pf:${p.id}`] ?? ''),
                );
              }),
            )
          : h('p.empty-note', 'No projects yet.'),
      ),
      h('p.err', { id: `ho-${id}-form-err`, role: 'alert', hidden: !formError }, formError),
      h(
        'div.row-flex.wrap',
        h('button.btn.send', { type: 'button', id: `ho-${id}-save`, disabled: saving, onclick: () => save(host) }, saving ? 'Saving…' : 'Save'),
        h('button.btn', { type: 'button', id: `ho-${id}-cancel`, onclick: closeEditor }, 'Cancel'),
      ),
    );
  };

  /** Checks everything, then saves what changed: the host, then each project’s folder. @param {any} host */
  const save = async (host) => {
    const d = /** @type {NonNullable<typeof draft>} */ (draft);
    errors = {};
    /** @type {Record<string, any>} */
    const settings = {};
    /** @type {Record<string, number>} */
    const keepAlive = {};
    for (const f of FIELDS) {
      const r = parse(f, d.v[f.key], host.settings);
      if (!r.ok) errors[f.key] = r.error;
      else if (f.key.startsWith('keepAlive.')) keepAlive[f.key.slice(10)] = r.value;
      else settings[f.key] = r.value;
    }
    settings.keepAlive = keepAlive;
    const dest = checkDestination(d.name);
    if (!dest.ok) errors.name = dest.error;
    const folderLabel = `The project’s folder on ${dest.ok ? dest.value : host.name}`;
    /** @type {[string, string | null][]} */
    const folders = [];
    for (const p of Object.values(S().projects)) {
      const v = (d.folders[p.id] ?? '').trim();
      if (v === (p.hostFolders?.[host.id] ?? '')) continue;
      const r = v ? checkHostPath(v, folderLabel) : { ok: true };
      if (!r.ok) errors[`pf:${p.id}`] = /** @type {any} */ (r).error;
      else folders.push([p.id, v || null]);
    }
    const bad = Object.keys(errors).filter((k) => errors[k]);
    if (!bad.length) {
      const all = checkHostSettings(settings, host.settings);
      if (!all.ok) errors.form = all.error;
    }
    if (bad.length || errors.form) {
      formError = errors.form ?? `${plural(bad.length, 'field needs', 'fields need')} a change before this can be saved: see the message under each.`;
      paint();
      const first = bad[0];
      document
        .getElementById(
          first ? (first.startsWith('pf:') ? `ho-${host.id}-pf-${first.slice(3)}` : `ho-${host.id}-${first.replace('.', '-')}`) : `ho-${host.id}-save`,
        )
        ?.focus();
      return;
    }
    formError = '';
    saving = true;
    paint();
    try {
      await api(`/api/hosts/${host.id}`, { ...(dest.value !== host.name ? { name: dest.value } : {}), settings }, 'PATCH');
      for (const [pid, folder] of folders) await api(`/api/projects/${pid}/hosts/${host.id}/folder`, { folder }, 'PUT');
      saving = false;
      toast({ title: `Saved ${dest.value}` });
      closeEditor();
    } catch (e) {
      saving = false;
      formError = [e.message, e.next].filter(Boolean).join(' ');
      paint();
      document.getElementById(`ho-${host.id}-save`)?.focus();
    }
  };

  // ── Asking first ──

  /** Installing writes on both computers, so it says what it writes, in describeInstall’s words, then installs. @param {any} host */
  const confirmInstall = async (host) => {
    let about;
    try {
      about = await api(`/api/hosts/${host.id}/install`, undefined, 'GET');
    } catch (e) {
      toast({ title: `Couldn’t get ready to install on ${host.name}`, text: e.message, level: 'blocking' });
      return;
    }
    const result = h('div.ho-install-result', { role: 'alert' });
    const go = h(
      'button.btn.send',
      {
        type: 'button',
        id: 'ho-install-go',
        onclick: async () => {
          go.disabled = true;
          go.textContent = 'Installing…';
          fill(result);
          try {
            const r = await api(`/api/hosts/${host.id}/install`, {});
            dlg.close();
            toast({
              title: r.installed === false ? `This Postbox was already on ${host.name}` : `Installed Postbox on ${host.name}`,
              text: 'Postbox connects when an agent’s turn there needs it.',
            });
          } catch (e) {
            fill(
              result,
              h(
                'div.callout',
                icon('warn'),
                h(
                  'div.grow',
                  { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
                  h('b', { style: { overflowWrap: 'anywhere' } }, e.message),
                  e.next ? h('p', { style: { margin: 0, overflowWrap: 'anywhere' } }, withCode(e.next)) : null,
                ),
              ),
            );
            go.disabled = false;
            go.textContent = 'Install again';
          }
        },
      },
      'Install',
    );
    const dlg = openDialog({
      title: `Install Postbox on ${host.name}?`,
      role: 'alertdialog',
      body: [
        h('p.ho-install-text', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 } }, about.text),
        about.commands?.length
          ? h(
              'details.ho-install-commands',
              h('summary.small', { style: { cursor: 'pointer' } }, 'The commands ssh runs there'),
              about.commands.map((/** @type {string} */ c) =>
                h('code', { style: { display: 'block', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', marginTop: '6px' } }, c),
              ),
            )
          : null,
        result,
      ],
      foot: [h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), go],
      initialFocus: () => go,
    });
    // The steps can be longer than a small window: the body scrolls, so it takes focus to scroll by keyboard.
    dlg.dialog.querySelector('.d-body')?.setAttribute('tabindex', '0');
  };

  /** Another Postbox drives the host: taking over disconnects it, so it says so first. @param {any} host */
  const confirmTakeover = (host) => {
    const go = h(
      'button.btn.send',
      {
        type: 'button',
        id: 'ho-takeover-go',
        onclick: () =>
          api(`/api/hosts/${host.id}/retry`, { takeover: true })
            .then(() => {
              dlg.close();
              say(`Taking over ${host.name}`);
            })
            .catch((e) => toast({ title: `Couldn’t take over ${host.name}`, text: [e.message, e.next].filter(Boolean).join(' '), level: 'blocking' })),
      },
      'Take over',
    );
    const dlg = openDialog({
      title: `Take over ${host.name}?`,
      role: 'alertdialog',
      body: [
        h(
          'p',
          { style: { margin: 0 } },
          `Another Postbox is connected to ${host.name} and driving it, such as Postbox on another computer of yours. Only one Postbox can drive a host at a time.`,
        ),
        h(
          'p',
          { style: { margin: 0 } },
          `Taking over disconnects the other one: it stops following its turns on ${host.name}, and can’t start new ones there until it takes over again. Turns already running there keep running.`,
        ),
      ],
      foot: [h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), go],
      initialFocus: () => go,
    });
  };

  /**
   * Removing stops the host’s turns, then removes Postbox from the host (the daemon deletes ~/.postbox-remote), then
   * forgets the host here. A refusal (409) says why, a turn it can’t stop or a host that didn’t confirm, with the next
   * step, and the host stays. One this computer has no token for can only be forgotten here, and says so.
   * @param {any} host
   */
  const confirmRemove = (host) => {
    const placed = Object.values(S().personas).filter((p) => p.remote?.hostId === host.id && !p.retired);
    const folders = Object.values(S().projects).filter((p) => p.hostFolders?.[host.id]).length;
    const st = S().hostStatus?.[host.id] ?? null;
    // No token here (a failure would be the host’s program missing there, which an install fixes).
    const noToken = st?.state === 'not-installed' && !st.failure;
    const label = noToken ? 'Remove host' : `Remove Postbox from ${host.name}`;
    const status = h('div.ho-remove-result', { role: 'alert' });
    const go = h(
      'button.btn.danger',
      {
        type: 'button',
        id: 'ho-remove-go',
        // It names the host, whose name may be long: it wraps rather than run off a narrow window.
        style: { whiteSpace: 'normal', overflowWrap: 'anywhere', height: 'auto', minHeight: '32px', paddingBlock: '6px' },
        onclick: async () => {
          go.disabled = true;
          go.textContent = noToken ? 'Removing…' : `Removing Postbox from ${host.name}…`;
          fill(status);
          try {
            const r = await api(`/api/hosts/${host.id}`, undefined, 'DELETE');
            dlg.close();
            toast({ title: `Removed ${host.name}`, text: r.stopped ? `Stopped ${plural(r.stopped, 'turn')} there first.` : '' });
          } catch (e) {
            fill(
              status,
              h(
                'div.callout',
                icon('warn'),
                h(
                  'div.grow',
                  { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
                  h('p', { style: { margin: 0, overflowWrap: 'anywhere' } }, e.message),
                  e.next ? h('p.ho-remove-next', { style: { margin: 0, overflowWrap: 'anywhere' } }, withCode(e.next)) : null,
                ),
              ),
            );
            go.disabled = false;
            go.textContent = 'Try again';
          }
        },
      },
      icon('trash', 'i-sm'),
      label,
    );
    const forgets = `its settings, ${folders ? plural(folders, 'project folder') : 'its project folders'} there, and its token on this computer`;
    const dlg = openDialog({
      title: `Remove ${host.name}?`,
      role: 'alertdialog',
      body: [
        noToken
          ? h(
              'p',
              { style: { margin: 0 } },
              `This computer has no token for ${host.name}, so Postbox can’t reach anything of its own there. It forgets the host here: ${forgets}. Any Postbox files on ${host.name} stay, in ~/.postbox-remote.`,
            )
          : h(
              'p',
              { style: { margin: 0 } },
              `Postbox stops the daemon and every turn still running on ${host.name}, and deletes ~/.postbox-remote there: its code, token, logs and turn records. Then it forgets the host here: ${forgets}.`,
            ),
        placed.length
          ? h(
              'p',
              { style: { margin: 0 } },
              `${placed.map((p) => `@${p.handle}`).join(', ')} ${placed.length === 1 ? 'runs' : 'run'} there, and can’t start a turn until you pick another place for ${placed.length === 1 ? 'it' : 'them'}.`,
            )
          : null,
        noToken
          ? null
          : h(
              'p.small.dim',
              { style: { margin: 0 } },
              `If ${host.name} can’t be reached or doesn’t confirm, Postbox keeps the host and its token, so you can try again.`,
            ),
        status,
      ],
      foot: [h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), go],
      initialFocus: () => go,
    });
  };

  paint();
  return root;
}
