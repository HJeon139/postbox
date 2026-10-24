// How a connection to a host fails, in words for the person (ssh.mjs): each failure’s kind, whether Postbox tries
// again on its own, what happened and what the person can do next, classified from ssh’s exit status and stderr or
// from the daemon’s `error` to hello.

/**
 * Each way a connection fails, and whether Postbox tries again on its own. The rest need the person: a sign-in, a
 * host key to check, an install, a newer version, or taking over from another Postbox.
 */
export const FAILURE_KINDS = Object.freeze({
  'sign-in': { retry: false },
  'host-key': { retry: false },
  unreachable: { retry: true },
  'not-installed': { retry: false },
  version: { retry: false },
  'bad-token': { retry: false },
  busy: { retry: false },
  // No Node 22 or later on the host to run the daemon: waiting doesn’t install one.
  'no-node': { retry: false },
  // The daemon closed the channel itself, such as after `remove`.
  ended: { retry: true },
  failed: { retry: true },
});
/** @typedef {keyof typeof FAILURE_KINDS} FailureKind */

/** Whether Postbox reconnects after this kind of failure without being asked. @param {string} kind */
export const retries = (kind) => FAILURE_KINDS[kind]?.retry ?? false;

/** A failed or dropped connection: what happened (`message`) and what the person can do next (`next`). */
export class SshFailure extends Error {
  /**
   * @param {FailureKind} kind @param {string} message @param {string} next
   * @param {{ code?: number|null, signal?: string|null, stderr?: string, changed?: boolean }} [detail]
   */
  constructor(kind, message, next, detail = {}) {
    super(message);
    this.name = 'SshFailure';
    this.kind = kind;
    this.next = next;
    this.retry = retries(kind);
    this.detail = detail;
  }
}

// The strings are OpenSSH’s, from tests/fixtures/ssh/failures.json, which says which were recorded and which come from
// openssh-portable’s source. Each is matched on its own line, since ssh adds warnings around them.
const HOST_KEY_CHANGED = /REMOTE HOST IDENTIFICATION HAS CHANGED|POSSIBLE DNS SPOOFING DETECTED|Host key for .* has changed/;
const HOST_KEY = /^Host key verification failed\.$|^No \S+ host key is known for /m;
const SIGN_IN = /: Permission denied \([^)]*\)\.$|^Received disconnect from .*: Too many authentication failures|^Permission denied, please try again\.$/m;
const UNREACHABLE = new RegExp(
  [
    'Could not resolve hostname',
    '^ssh: connect to host .* port \\S+: ',
    '^Timeout, server .* not responding\\.$',
    '^Connection (?:closed|reset) by ',
    '^kex_exchange_identification: ',
    '^Connection timed out during banner exchange',
    'Broken pipe$',
    'Network is unreachable$',
    'No route to host$',
  ].join('|'),
  'm',
);
const OFFENDING = /^Offending \S+ key in (.+):(\d+)$/m;

/** The destination’s host, without a user, for commands like ssh-keygen -R. @param {string} d */
const hostOnly = (d) => d.replace(/^.*@/, '');
/** The last line of ssh’s output that says something, to quote. @param {string} text */
const lastLine = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('**') && !/^@+$/.test(l))
    .at(-1) ?? '';

/**
 * A failure in words for the person, by kind.
 * @param {FailureKind} kind @param {string} d  the host’s destination
 * @param {{ code?: number|null, signal?: string|null, stderr?: string, changed?: boolean, why?: string, said?: string }} [detail]
 *   why: Postbox’s own reason, a sentence; said: the line of ssh’s stderr to quote, else its last line that says something.
 * @returns {SshFailure}
 */
export function failure(kind, d, detail = {}) {
  // Postbox’s own reason, else the line of ssh’s stderr that says the most.
  const said = detail.said || lastLine(detail.stderr ?? '');
  const quote = detail.why ? ` ${detail.why}` : said ? ` ssh said: “${said}”` : '';
  const tryAgain = 'Postbox tries again on its own while a turn runs or a prompt waits.';
  const text = {
    'sign-in': [
      `Postbox couldn’t sign in to ${d}: ssh had no key or certificate it could use without asking.`,
      `Sign in to ${d} in a terminal (run \`ssh ${d}\`), then reconnect.`,
    ],
    'host-key': detail.changed
      ? [
          `${d}’s host key has changed since you last connected, so ssh refused it. The host may have been rebuilt, or someone may be intercepting the connection.`,
          `Check the new key with whoever runs ${d} before you trust it. If it’s right, remove the old one with \`ssh-keygen -R ${hostOnly(d)}\`${
            OFFENDING.test(detail.stderr ?? '') ? ` (ssh found it at ${(detail.stderr ?? '').match(OFFENDING)?.slice(1).join(', line ')})` : ''
          }, connect once with \`ssh ${d}\` in a terminal, then reconnect.`,
        ]
      : [
          `ssh doesn’t know ${d}’s host key yet, and it won’t accept a new one without asking.`,
          `Connect once in a terminal with \`ssh ${d}\`, check that the fingerprint it shows is the host’s, accept it, then reconnect.`,
        ],
    unreachable: [
      `Postbox couldn’t reach ${d}.${quote}`,
      `Check that ${d} is running and that this computer can reach its network, such as over a VPN. ${tryAgain}`,
    ],
    'not-installed': [
      `Postbox’s host program isn’t installed on ${d}, or it couldn’t start.${quote}`,
      `Install Postbox on ${d} from the host’s settings, then reconnect.`,
    ],
    version: [
      `The Postbox daemon on ${d} speaks another version of the protocol.${quote}`,
      `Install this Postbox’s version on ${d} from the host’s settings, then reconnect.`,
    ],
    'bad-token': [`The daemon on ${d} didn’t accept Postbox’s token.${quote}`, `Reinstall Postbox on ${d} from the host’s settings, then reconnect.`],
    busy: [`Another Postbox is using ${d}.${quote}`, `Take over ${d} to use it from here; the other Postbox is disconnected.`],
    'no-node': [
      `Postbox’s host program couldn’t start on ${d}: it needs Node 22 or later.${quote}`,
      `Install Node 22 or later on ${d}, or set its Node path in Postbox’s host settings, then reconnect.`,
    ],
    ended: [`The Postbox daemon on ${d} closed the connection.`, tryAgain],
    failed: [
      `The connection to ${d} failed${detail.code != null ? ` (ssh exited with ${detail.code})` : detail.signal ? ` (ssh ended on ${detail.signal})` : ''}.${quote}`,
      `Run \`ssh ${d}\` in a terminal to see what ssh says. ${tryAgain}`,
    ],
  }[kind];
  const { why: _why, said: _said, ...rest } = detail;
  return new SshFailure(kind, text[0], text[1], rest);
}

/**
 * Classifies how ssh ended before or after the daemon answered.
 * @param {{ destination: string, code: number|null, signal: string|null, stderr: string }} o
 * @returns {SshFailure}
 */
export function classifyExit({ destination, code, signal, stderr }) {
  const text = stderr.replace(/\r\n?/g, '\n');
  const detail = { code, signal, stderr: text };
  if (code === 255) {
    if (HOST_KEY_CHANGED.test(text)) return failure('host-key', destination, { ...detail, changed: true });
    if (HOST_KEY.test(text)) return failure('host-key', destination, detail);
    if (SIGN_IN.test(text)) return failure('sign-in', destination, detail);
    if (UNREACHABLE.test(text)) return failure('unreachable', destination, { ...detail, said: lastMatch(text) });
    return failure('failed', destination, detail);
  }
  // The login shell couldn’t find (127) or run (126) the host program: the fixed command names nothing else.
  if (code === 127 || code === 126) return failure('not-installed', destination, detail);
  if (code === 0) return failure('ended', destination, detail);
  return failure('failed', destination, detail);
}

/** The line UNREACHABLE matched, to quote. @param {string} text */
function lastMatch(text) {
  return (
    text
      .split('\n')
      .filter((l) => UNREACHABLE.test(l))
      .at(-1)
      ?.trim() ?? ''
  );
}

/** The daemon’s `error` to hello, as a failure. @param {string} destination @param {{ code: string, message: string }} m */
export function classifyRefusal(destination, m) {
  const kind = m.code === 'version' || m.code === 'bad-token' || m.code === 'busy' || m.code === 'no-node' ? m.code : 'failed';
  return failure(kind, destination, { why: `The host’s daemon said: “${m.message}”` });
}
