// A Postbox’s hello (daemon.mjs’s header, #120): the protocol version and the host’s token, one driver at a time
// unless a hello takes over, and the welcome, with the programs found, the problems and every turn folder.

import { HOST_DEFAULTS, PROTOCOL_VERSION, REMOTE_LIMITS } from '../../../shared/remote-protocol.mjs';
import { tokenMatches } from './daemon-files.mjs';
import { fail, send } from './daemon-reply.mjs';
import { checkIdle, scan } from './daemon-scan.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */

/**
 * The lingering warning, from the host’s facts, before each welcome, so the first one has it whether or not a turn
 * has run, and it goes once lingering is on. launchRunner’s rule: a runner goes into a systemd user scope only with
 * `detach: 'auto'` where logind kills a user’s processes at logout, and only a scoped runner ends at the last logout
 * (without the scope, a probe saw turns survive with lingering off). Two quick commands, so it’s asked each time.
 */
/** @param {Daemon} d */
function checkLinger(d) {
  const facts = d.settings.detach === 'auto' ? d.logind() : null;
  if (facts?.killUserProcesses === true && facts.linger === false)
    d.problems.set(
      'no-linger',
      'Lingering is off for this user, so turns end when the last session on the host ends. Run “loginctl enable-linger” on the host to keep them running.',
    );
  else d.problems.delete('no-linger');
}

/** @param {Daemon} d @param {Conn} c @param {any} m */
export async function hello(d, c, m) {
  if (m.version !== PROTOCOL_VERSION)
    return fail(
      c,
      'version',
      `This host’s daemon speaks protocol ${PROTOCOL_VERSION}, and Postbox sent ${m.version}. Install this Postbox’s version on the host.`,
      'hello',
    );
  if (!tokenMatches(d, m.token))
    return fail(c, 'bad-token', `The token doesn’t match the host’s, in ~/.postbox-remote/token. Reinstall Postbox on the host.`, 'hello');
  if (d.driver && d.driver !== c && !d.driver.closed) {
    const old = d.driver;
    // The same Postbox back: its old connection is one whose ssh died before this host noticed.
    const same = typeof m.instance === 'string' && old.instance === m.instance;
    if (!same && !m.takeover) return fail(c, 'busy', 'Another Postbox is using this host. Take over to use it from here.', 'hello');
    if (same) d.log(`Connection ${c.id} replaced ${old.id}, the same Postbox’s.`);
    else {
      d.log(`Connection ${c.id} took over from ${old.id}.`);
      fail(old, 'taken-over', 'Another Postbox took over this host.');
    }
    old.close();
  }
  c.instance = typeof m.instance === 'string' ? m.instance : null;
  d.driver = c;
  c.ready = true;
  d.settings = { ...HOST_DEFAULTS, ...(m.settings ?? {}) };
  d.programs = await d.findPrograms({ home: d.home, settings: d.settings });
  if (c.closed) return;
  checkLinger(d);
  const turns = await scan(d);
  const allProblems = [...d.programs.problems, ...[...d.problems].map(([code, text]) => ({ code, message: text }))].slice(0, REMOTE_LIMITS.problems);
  await send(c, 'welcome', { version: PROTOCOL_VERSION, home: d.home, node: d.programs.node, harnesses: d.programs.harnesses, problems: allProblems, turns });
  checkIdle(d);
  await d.brk.hello?.((type, body) => send(c, type, body));
}
