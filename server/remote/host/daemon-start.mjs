// A turn’s start (daemon.mjs’s header, #120): the checks, the turn folder and its files, a Kiro agent file where the
// runner’s Kiro reads agents, start.json, and the runner’s launch, answered `started` once the runner is up.

import { promises as fsp } from 'node:fs';
import { dirname, posix } from 'node:path';
import { DIR_MODE, FILE_MODE, socketPathFits, TURN_FILES, validateStartRecord } from '../../../shared/remote-protocol.mjs';
import { RUNNER_START_POLL_MS } from './daemon-constants.mjs';
import { exists, runnerAlive, writeAtomic } from './daemon-files.mjs';
import { fail, send } from './daemon-reply.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */
/** @typedef {(code: string, text: string) => undefined} FailStart */

/**
 * Whether a path is under a folder, once symbolic links are followed: its nearest part that exists, real, is the
 * real folder or under it, and the path isn’t the folder itself. A part that doesn’t exist yet is made later, under
 * that one.
 * @param {string} top @param {string} path  an absolute path with no “..” or “.” parts
 */
async function inside(top, path) {
  const real = (x) => fsp.realpath(x).catch(() => null);
  const realTop = await real(top);
  if (!realTop) return false;
  let at = path;
  let found = await real(at);
  while (!found && at !== '/') {
    at = dirname(at);
    found = await real(at);
  }
  if (!found) return false;
  // Under it, or the folder itself when the path’s own part doesn’t exist yet (so it’s made under it).
  if (found === realTop) return at !== path;
  return found.startsWith(realTop === '/' ? '/' : `${realTop}/`);
}

/**
 * The agents folder of the Kiro home a turn’s runner will use, as Kiro finds it: start.env’s KIRO_HOME (an Isolated
 * persona’s, which must be under ~/.postbox-remote), else the daemon’s own (the runner inherits it), else ~/.kiro.
 * @param {Daemon} d @param {Record<string, string>} startEnv @returns {Promise<{ dir: string } | { error: string }>}
 */
async function kiroAgents(d, startEnv) {
  const plain = (x) => x.startsWith('/') && x === posix.normalize(x) && (x === '/' || !x.endsWith('/'));
  if (Object.hasOwn(startEnv, 'KIRO_HOME')) {
    const kiro = startEnv.KIRO_HOME;
    if (!plain(kiro) || !(await inside(d.p.root, kiro)))
      return { error: `The turn’s KIRO_HOME ${kiro} isn’t under ${d.p.root}, so Postbox won’t write a Kiro agent file there.` };
    return { dir: `${kiro}/agents` };
  }
  const own = d.env.KIRO_HOME;
  if (own) {
    if (!plain(own)) return { error: `This host’s KIRO_HOME, ${own}, isn’t an absolute path, so Postbox can’t tell where Kiro reads agents from.` };
    return { dir: `${own === '/' ? '' : own}/agents` };
  }
  return { dir: `${d.home === '/' ? '' : d.home}/.kiro/agents` };
}

/**
 * A start, once for its turn at a time, and none for a turn already asked to stop (stop).
 * @param {Daemon} d @param {Conn} c @param {any} m
 */
export async function start(d, c, m) {
  if (d.stoppedFirst.has(m.turn))
    return fail(c, 'turn-stopped', `Turn ${m.turn} was stopped before it started here, so it isn’t started now.`, 'start', m.turn);
  if (d.starting.has(m.turn)) return fail(c, 'turn-exists', `There’s already a turn ${m.turn} on this host.`, 'start', m.turn);
  const run = startTurn(d, c, m);
  d.starting.set(
    m.turn,
    run.then(
      () => {},
      () => {},
    ),
  );
  try {
    return await run;
  } finally {
    d.starting.delete(m.turn);
  }
}

/** @param {Daemon} d @param {Conn} c @param {any} m */
async function startTurn(d, c, m) {
  /** @type {FailStart} */
  const failStart = (code, text) => fail(c, code, text, 'start', m.turn);
  const ready = await checkStart(d, m, failStart);
  if (!ready) return;
  try {
    await fsp.mkdir(d.p.turns, { recursive: true, mode: DIR_MODE });
    await fsp.mkdir(ready.dir, { mode: DIR_MODE });
  } catch (e) {
    if (e.code === 'EEXIST') return failStart('turn-exists', `There’s already a turn ${m.turn} on this host.`);
    throw e;
  }
  if (!(await launch(d, m, ready, failStart))) return;
  // `started` means the runner is up (the protocol): its socket answers, so a `write` right after it reaches the
  // runner, and messages on a channel are handled in order, so one sent before this answer waits for it.
  const up = await runnerUp(d, m.turn);
  if (up !== true) return failStart('start-failed', `Turn ${m.turn}’s runner didn’t start: ${up}`);
  send(c, 'started', { turn: m.turn });
  d.brk.started?.(m.turn);
}

/**
 * The checks before the turn folder is made: the harness, the socket path, no folder for the turn yet, the Kiro
 * agents folder, the working folder, and start.json’s record. What the launch needs, or nothing once the start failed.
 * @param {Daemon} d @param {any} m @param {FailStart} failStart
 */
async function checkStart(d, m, failStart) {
  const harness = d.programs?.harnesses.find((h) => h.name === m.harness);
  if (!harness?.path)
    return failStart('no-harness', `${m.harness} isn’t installed on this host. The daemon looked in ${harness?.looked.join(', ') || 'no folders'}.`);
  const node = d.programs?.node.path ?? process.execPath;
  const dir = d.p.turn(m.turn);
  if (!socketPathFits(d.p.turn(m.turn, TURN_FILES.socket)))
    return failStart('start-failed', `The turn’s socket path, ${d.p.turn(m.turn, TURN_FILES.socket)}, is too long for a Unix socket on Linux.`);
  if (await exists(dir)) return failStart('turn-exists', `There’s already a turn ${m.turn} on this host.`);
  // A Kiro agent file goes in the agents folder of the Kiro home the runner will use (kiroAgents).
  const agents = m.agentFile ? await kiroAgents(d, m.env) : null;
  if (agents && 'error' in agents) return failStart('start-failed', agents.error);
  if (!(await workFolder(d, m, failStart))) return;
  const record = { turn: m.turn, harness: m.harness, program: harness.path, argv: m.argv, env: m.env, stdin: m.stdin, folder: m.folder };
  const checked = validateStartRecord(record);
  if (!checked.ok) return failStart('start-failed', checked.error);
  return { node, dir, agents, record };
}

/**
 * The working folder: the project’s own must exist; the default one under ~/postbox-work is made. Whether it’s there.
 * @param {Daemon} d @param {any} m @param {FailStart} failStart
 */
async function workFolder(d, m, failStart) {
  try {
    if (!(await fsp.stat(m.folder)).isDirectory()) return failStart('start-failed', `${m.folder} isn’t a folder on this host.`);
  } catch (e) {
    if (e.code !== 'ENOENT') return failStart('start-failed', `Couldn’t open ${m.folder}: ${e.message}`);
    if (!m.folder.startsWith(`${d.home === '/' ? '' : d.home}/postbox-work/`))
      return failStart('start-failed', `The folder ${m.folder} doesn’t exist on this host. Create it, or change the project’s folder for this host.`);
    await fsp.mkdir(m.folder, { recursive: true, mode: DIR_MODE });
  }
  return true;
}

/**
 * Writes the turn’s files, its agent file and start.json, and launches its runner. Whether it launched; if not,
 * nothing ran, so the folder goes, and the same turn can be started again.
 * @param {Daemon} d @param {any} m @param {{ node: string, dir: string, agents: { dir: string } | null, record: object }} ready
 * @param {FailStart} failStart
 */
async function launch(d, m, { node, dir, agents, record }, failStart) {
  try {
    for (const f of m.files) await fsp.writeFile(`${dir}/${f.name}`, f.text, { mode: FILE_MODE, flag: 'wx' });
    await d.brk.starting?.(m.turn);
    // Outside the turn folder (a Kiro home’s agents folder), recorded in it, so it goes when the turn ends.
    if (m.agentFile && agents && 'dir' in agents) await d.cleanup.writeAgentFile(m.turn, { dir: agents.dir, name: m.agentFile.name, text: m.agentFile.text });
    await writeAtomic(d, `${dir}/${TURN_FILES.start}`, JSON.stringify(record));
    // A stop came meanwhile (from the next channel, this one having dropped): nothing runs. Checked just before the
    // launch, so a stop after it waits for the runner and stops it.
    if (d.stoppedFirst.has(m.turn)) throw Object.assign(new Error('it was stopped before its runner launched.'), { code: 'turn-stopped' });
    const { pid, scoped } = await d.launchRunner({ node, turn: m.turn, paths: d.p, scope: d.settings.detach, spawn: d.spawn, logind: d.logind });
    d.log(`Started turn ${m.turn} (${m.harness}), runner ${pid}${scoped ? ', in a systemd user scope' : ''}.`);
    return true;
  } catch (e) {
    await d.cleanup.dropAgentFile(m.turn).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    failStart(e.code === 'turn-stopped' ? 'turn-stopped' : 'start-failed', `Couldn’t start turn ${m.turn}: ${e.message}`);
    return false;
  }
}

/**
 * Waits for a launched runner: true once its socket answers or exit.json is there (a harness that ended at once),
 * else why not. A runner that refuses its turn says why in err.log before runner.json, and exits.
 * @param {Daemon} d @param {string} turn @returns {Promise<true | string>}
 */
async function runnerUp(d, turn) {
  const tries = Math.max(1, Math.ceil(d.runnerStartMs / RUNNER_START_POLL_MS));
  for (let i = 0; i < tries; i++) {
    if ((await runnerAlive(d, turn)) || (await exists(d.p.turn(turn, TURN_FILES.exit)))) return true;
    if (!(await exists(d.p.turn(turn, TURN_FILES.runner)))) {
      const said = (await fsp.readFile(d.p.turn(turn, TURN_FILES.err), 'utf8').catch(() => ''))
        .split('\n')
        .filter((l) => l.startsWith('postbox runner: '))
        .at(-1);
      if (said) return said.slice('postbox runner: '.length);
    }
    if (d.closed) return 'the daemon is closing.';
    await new Promise((resolve) => setTimeout(resolve, RUNNER_START_POLL_MS).unref());
  }
  return `its socket didn’t answer within ${Math.round(d.runnerStartMs / 1000)} s; see ${d.p.turn(turn, TURN_FILES.err)}.`;
}
