// A remote host’s settings and the checks on them (#120): the design’s settings table, with defaults and
// ranges, and the checks on a host’s SSH destination and on a project’s folder on a host. Times are in
// milliseconds and sizes in bytes. It’s pure, so the server, the host’s daemon and the page can share it.
//
// Each check returns { ok: true, value } or { ok: false, error }, with an error a person can act on; the
// runtime turns a refusal into a 422 where the input enters.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;

/**
 * @typedef {{ interval: number, count: number }} KeepAlive
 * @typedef {{
 *   stallTimeout: number, permissionWaitMax: number, idleTimeout: number, logRetention: number, logMaxBytes: number,
 *   keepAlive: KeepAlive, dedicatedConnection: boolean, forwardAgent: boolean, denyPrompts: boolean,
 *   nodePath: string|null, claudePath: string|null, kiroPath: string|null, codexPath: string|null,
 *   detach: 'auto' | 'setsid', signInCheck: string[]|null,
 * }} HostSettings
 * @typedef {{ id: string, name: string, settings: HostSettings, createdAt: number }} Host
 * @typedef {{ ok: true, value: any } | { ok: false, error: string }} Checked
 */

/** @returns {HostSettings} */
export function defaultHostSettings() {
  return {
    stallTimeout: 15 * MINUTE,
    permissionWaitMax: 24 * HOUR,
    idleTimeout: 30 * MINUTE,
    logRetention: 7 * DAY,
    logMaxBytes: 256 * MIB,
    keepAlive: { interval: 15 * SECOND, count: 3 },
    dedicatedConnection: true,
    forwardAgent: false,
    // Unattended runs (#120, D2): Claude Code denies what it would ask about (`--permission-prompts none`, v2.1.259
    // or later) instead of waiting on a card nobody may answer. Off, a prompt waits up to permissionWaitMax.
    denyPrompts: false,
    nodePath: null,
    claudePath: null,
    kiroPath: null,
    codexPath: null,
    detach: 'auto',
    signInCheck: null,
  };
}

/**
 * The numeric settings’ ranges, inclusive, with how each bound reads in an error.
 * @type {Readonly<Record<string, { min: number, max: number, step: number, range: string }>>}
 */
export const RANGES = Object.freeze({
  // A model endpoint that never answers gets an api_retry event about 6 minutes apart, so a turn waiting on one
  // isn’t hung: the floor stays well above that (the design, “Turn states”).
  stallTimeout: { min: 10 * MINUTE, max: DAY, step: SECOND, range: '10 min to 24 h' },
  // Claude Code ends any MCP call after about 27.8 hours unless the server’s `timeout` raises it, and only 24-hour
  // waits are being measured (the plan’s P1), so 24 h is the ceiling until a longer wait is shown to hold.
  permissionWaitMax: { min: MINUTE, max: DAY, step: SECOND, range: '1 min to 24 h' },
  idleTimeout: { min: MINUTE, max: 7 * DAY, step: SECOND, range: '1 min to 7 days' },
  logRetention: { min: HOUR, max: 90 * DAY, step: SECOND, range: '1 h to 90 days' },
  logMaxBytes: { min: 16 * MIB, max: 4096 * MIB, step: 1, range: '16 MiB to 4 GiB' },
  // ssh’s ServerAliveInterval is in whole seconds.
  'keepAlive.interval': { min: SECOND, max: 5 * MINUTE, step: SECOND, range: '1 s to 5 min, in whole seconds' },
  'keepAlive.count': { min: 1, max: 10, step: 1, range: '1 to 10' },
});

export const DETACH_MODES = ['auto', 'setsid'];
export const PROGRAM_PATHS = ['nodePath', 'claudePath', 'kiroPath', 'codexPath'];
const BOOLEANS = ['dedicatedConnection', 'forwardAgent', 'denyPrompts'];
const KEYS = Object.keys(defaultHostSettings());

/** The longest destination: a host name’s 253 characters, a user name and an @. */
export const DESTINATION_MAX = 255;
/** The longest path on a host, in UTF-8 bytes: Linux’s PATH_MAX, 4096, less its NUL. */
export const PATH_BYTES = 4095;
const SIGN_IN_ARGS = 32;
const SIGN_IN_ARG_MAX = 1024;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters in a path or argument are exactly what this rejects
const CONTROL = /[\u0000-\u001f\u007f]/;
// An alias from ~/.ssh/config, a host name, an IPv6 address in brackets, each with an optional user@.
const DESTINATION = /^[A-Za-z0-9_.@:%[\]-]+$/;
const ENCODER = new TextEncoder();

/** @param {any} value @returns {Checked} */
const ok = (value) => ({ ok: true, value });
/** @param {string} error @returns {Checked} */
const no = (error) => ({ ok: false, error });

/**
 * A host’s SSH destination, as the person typed it. It becomes an argument to `ssh`, so anything `ssh` could read as
 * an option, or a shell could split, is refused.
 * @param {unknown} name @returns {Checked}
 */
export function checkDestination(name) {
  const allowed = 'Use an alias from ~/.ssh/config, a host name, or user@host: letters, digits and . _ - @ : % [ ].';
  if (typeof name !== 'string') return no(`A host is its SSH destination, as text. ${allowed}`);
  // Refused rather than trimmed (SECURITY.md, “Every input is untrusted”): the spaces check below says why.
  const s = name;
  if (!s.trim()) return no(`Name the host. ${allowed}`);
  if (s.length > DESTINATION_MAX) return no(`That destination is ${s.length} characters; the most is ${DESTINATION_MAX}. ${allowed}`);
  if (s.startsWith('-')) return no(`A destination can’t start with “-”, since ssh would read it as an option. ${allowed}`);
  if (/\s/.test(s) || CONTROL.test(s)) return no(`A destination can’t contain spaces or control characters. ${allowed}`);
  if (!DESTINATION.test(s)) return no(`That destination has a character ssh destinations don’t use. ${allowed}`);
  if (!/[A-Za-z0-9]/.test(s.replace(/^.*@/, ''))) return no(`Name a host after the @. ${allowed}`);
  return ok(s);
}

/**
 * An absolute POSIX path on a host: a program’s path, or a project’s folder there. It’s the one rule for a host path,
 * here and in remote-protocol.mjs, so a path saved in settings is one every `hello` and `start` carries. The host uses
 * a path as given, so it must be written plainly: no empty, . or .. parts, and no trailing /.
 * @param {unknown} path @param {string} what  how the error names it, such as “claudePath” @returns {Checked}
 */
export function checkHostPath(path, what) {
  if (typeof path !== 'string') return no(`${what} is a path on the host, as text.`);
  if (!path.startsWith('/')) return no(`${what} must be an absolute path on the host, starting with /. ~ isn’t expanded.`);
  if (CONTROL.test(path)) return no(`${what} can’t contain control characters, such as a new line.`);
  // UTF-16 code units never outnumber UTF-8 bytes, so a long string is refused without encoding it.
  if (path.length > PATH_BYTES || ENCODER.encode(path).length > PATH_BYTES)
    return no(`${what} is over ${PATH_BYTES} bytes, the most a path on the host can be.`);
  if (path === '/') return ok(path);
  const parts = path.slice(1).split('/');
  if (parts.includes('..')) return no(`${what} can’t contain “..”. Write the folder’s full path.`);
  if (parts.includes('.')) return no(`${what} can’t contain a “.” part. Write the path without it.`);
  if (path.endsWith('/')) return no(`${what} can’t end with “/”, since the host uses the path as given. Write ${path.replace(/\/+$/, '') || '/'} instead.`);
  if (parts.includes('')) return no(`${what} can’t contain “//”. Write each / once.`);
  return ok(path);
}

/**
 * A partial settings change over `base` (the defaults for a new host). Unknown keys are refused, so a misspelled
 * setting doesn’t pass as a default; `keepAlive` may be given in part.
 * @param {unknown} patch @param {HostSettings} [base] @returns {Checked}
 */
export function checkHostSettings(patch, base = defaultHostSettings()) {
  if (patch === undefined || patch === null) return ok(structuredClone(base));
  if (typeof patch !== 'object' || Array.isArray(patch)) return no('Host settings are an object of setting names and values.');
  const unknown = Object.keys(patch).filter((k) => !KEYS.includes(k));
  if (unknown.length) return no(`There’s no host setting ${unknown.map((k) => `“${k}”`).join(', ')}. The settings are ${KEYS.join(', ')}.`);
  const next = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    const r = checkSetting(key, value, next);
    if (!r.ok) return r;
    next[key] = r.value;
  }
  return ok(next);
}

/** @param {string} key @param {unknown} value @param {HostSettings} next @returns {Checked} */
function checkSetting(key, value, next) {
  if (Object.hasOwn(RANGES, key)) return checkNumber(key, value);
  if (key === 'keepAlive') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return no('keepAlive is { interval, count }: interval in milliseconds.');
    const extra = Object.keys(value).filter((k) => k !== 'interval' && k !== 'count');
    if (extra.length) return no(`keepAlive has only interval and count, not ${extra.join(', ')}.`);
    const out = { ...next.keepAlive };
    for (const k of /** @type {const} */ (['interval', 'count'])) {
      if (value[k] === undefined) continue;
      const r = checkNumber(`keepAlive.${k}`, value[k]);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return ok(out);
  }
  if (BOOLEANS.includes(key)) return typeof value === 'boolean' ? ok(value) : no(`${key} is true or false.`);
  if (PROGRAM_PATHS.includes(key)) return value === null ? ok(null) : checkHostPath(value, key);
  if (key === 'detach') return DETACH_MODES.includes(/** @type {any} */ (value)) ? ok(value) : no(`detach is one of ${DETACH_MODES.join(', ')}.`);
  if (key === 'signInCheck') return checkSignInCheck(value);
  throw new Error(`Unhandled host setting ${key}`);
}

/** @param {string} key @param {unknown} value @returns {Checked} */
function checkNumber(key, value) {
  const { min, max, step, range } = RANGES[key];
  const unit = step === 1 ? '' : ', in milliseconds';
  if (typeof value !== 'number' || !Number.isInteger(value)) return no(`${key} is a whole number${unit}: ${range}.`);
  if (value < min || value > max) return no(`${key} must be ${range}; ${value} is out of range.`);
  if (value % step) return no(`${key} must be ${range}.`);
  return ok(value);
}

/**
 * The command that checks the host’s sign-in, as an argument list the daemon runs without a shell, or null for none.
 * @param {unknown} value @returns {Checked}
 */
function checkSignInCheck(value) {
  if (value === null) return ok(null);
  if (typeof value === 'string') return no('signInCheck is a list of arguments, such as ["klist", "-s"], not a command line: no shell runs it.');
  if (!Array.isArray(value) || !value.length) return no('signInCheck is a list of arguments, such as ["klist", "-s"], or null for none.');
  if (value.length > SIGN_IN_ARGS) return no(`signInCheck has ${value.length} arguments; the most is ${SIGN_IN_ARGS}.`);
  for (const [i, arg] of value.entries()) {
    if (typeof arg !== 'string') return no(`signInCheck’s argument ${i + 1} isn’t text.`);
    if (arg.length > SIGN_IN_ARG_MAX) return no(`signInCheck’s argument ${i + 1} is longer than ${SIGN_IN_ARG_MAX} characters.`);
    if (CONTROL.test(arg)) return no(`signInCheck’s argument ${i + 1} contains a control character, such as a new line.`);
  }
  if (!value[0].trim() || value[0].startsWith('-')) return no('signInCheck’s first argument is the program to run, such as klist.');
  return ok([...value]);
}
