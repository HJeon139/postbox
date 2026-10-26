// The settings of a remote host (#120) as the Hosts tab edits them (app/js/hosts.mjs): the design’s table, in the
// groups the editor shows, each with the unit you type it in, and how a value you typed becomes the setting. The
// checks are the server’s own, from shared/remote-settings.mjs, so a refusal here reads as the server’s would.

import { checkHostPath, checkHostSettings, RANGES } from '/shared/remote-settings.mjs';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;
/** The units a duration is written in, largest last. */
export const UNITS = [
  ['min', MINUTE],
  ['h', HOUR],
  ['days', DAY],
];

/**
 * @typedef {{ ok: true, value: any } | { ok: false, error: string }} Parsed
 * @typedef {{ key: string, label: string, help: string, kind: 'duration' | 'number' | 'check' | 'path' | 'detach' | 'argv',
 *   unit?: string, scale?: number }} Field
 *   key: the setting, or keepAlive.interval / keepAlive.count; unit and scale: a number’s unit and its size in the
 *   setting’s own unit (milliseconds or bytes).
 */

/** The settings, in the groups the editor shows them in. @type {[string, Field[]][]} */
export const GROUPS = [
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
        help: 'On, Postbox’s ssh options apply. Off, it shares your multiplexed connection, such as to a jump host you can’t reopen: any port forwards that connection opened stay open, and its host key was checked as you opened it.',
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
export const FIELDS = GROUPS.flatMap(([, fields]) => fields);
export const PROGRAMS_HELP = 'Absolute paths on the host, for installs in unusual places. Empty: the daemon looks on PATH and in the usual install folders.';
export const DETACH = [
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
export function shown(f, s) {
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
export function parse(f, v, base) {
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
