// `!command` in the composer (#67): the command line the person runs, in the conversation’s folder, as them. Output
// streams into a command item, bounded, and the agents read it on their next turn without being woken. shell.mjs
// spawns the process; this module decides the folder, keeps the item, and stops what runs. Moved out of
// server/runtime.mjs; Runtime keeps a method of the same name that delegates here.

import { workFolder } from './adapters/folder.mjs';
import { clipText, httpError } from './helpers.mjs';
import { hereFolder, requestAdapter } from './remote/placement.mjs';
import { runShell } from './shell.mjs';
import { whenWritable } from './store-outage.mjs';

// A `!command`’s output, bounded: the item keeps its last characters, it reaches the browser in flushes, and once cut,
// its text is refreshed rarely and a limited number of times.
export const MAX_COMMAND_OUTPUT = 64 * 1024;
const COMMAND_FLUSH_MS = 100;
const COMMAND_REFRESH_MS = 5000;
const MAX_COMMAND_REFRESHES = 60;

/**
 * The folder a conversation’s `!` commands run in: where the agent that replies there works, as its adapter decides
 * (its own folder, the project’s, or a workspace of its own), else the project’s.
 * `!` runs on this computer even when that agent runs on a host (#67, #120): then it’s the project’s folder here,
 * else the workspace of its own the agent would have here, never a path on the host, and `host` names the host.
 * @param {string} threadId @returns {Promise<{ folder: string|null, host: string|null }>}
 */
export async function commandFolder(rt, threadId) {
  const t = rt.thread(threadId);
  const members = rt.sessionsIn(threadId).filter((x) => !x.retiredFork);
  const se = members.find((x) => x.id === t.lastSpeaker) ?? members[0];
  const persona = se ? rt.personaFor(se) : null;
  const project = rt.s.projects[t.projectId] ?? null;
  const adapter = persona ? requestAdapter(rt, se.handle, persona) : null;
  if (persona?.remote?.hostId) return hereFolder(rt, persona, project, adapter);
  return { folder: await workFolder(adapter, persona, project), host: null };
}

/**
 * Runs `!command` (#67) as the person, in the conversation’s folder. Output streams into a command item; the item
 * ends with the exit code and the duration. The agents read it with what they missed, at the start of their next
 * turn. What the store keeps is bounded: the item holds the last MAX_COMMAND_OUTPUT characters (it says when
 * earlier output was cut), and once output passes that, the item is refreshed with its end at most every
 * COMMAND_REFRESH_MS, and at most MAX_COMMAND_REFRESHES times, then once more when the command ends.
 * @param {string} threadId @param {string} command
 */
export async function runShellCommand(rt, threadId, command) {
  rt.thread(threadId);
  const line = String(command ?? '').trim();
  if (!line) throw httpError(422, 'Write a command after the !.');
  if (line.length > 10000) throw httpError(422, 'A command is limited to 10,000 characters.');
  const { folder: cwd, host } = await rt.commandFolder(threadId);
  if (!cwd) throw httpError(409, 'This conversation has no folder to run commands in. Give the project or the agent a folder first.');
  // Said once, as the output’s first line, when the agent here runs on a host: you, and the agents, see where it ran.
  const note = host ? `! commands run on this computer, not on ${host}.\n` : '';
  const startedAt = Date.now();
  const it = rt.addItem(threadId, {
    kind: 'command',
    command: line,
    cwd,
    ...(host ? { notOn: host } : {}),
    status: 'running',
    text: note,
    cut: false,
    exitCode: null,
    signal: null,
    startedAt,
  });
  const output = commandOutput(rt, threadId, it.id, note);
  const run = { stopped: false, stop: () => false, kill: () => false, done: Promise.resolve(), flush: output.flush };
  rt.shellRuns.set(it.id, run);
  const handle = runShell({
    command: line,
    cwd,
    ...(rt.spawnShell ? { spawnImpl: rt.spawnShell } : {}),
    onOutput: output.add,
    onExit: (exit) => {
      output.flush({ final: true });
      rt.shellRuns.delete(it.id);
      endCommand(rt, threadId, it.id, { run, cut: output.cut(), startedAt, exit });
    },
  });
  Object.assign(run, { stop: handle.stop, kill: handle.kill, done: handle.done });
  return { item: it };
}

/**
 * A running command’s output, bounded: `add` keeps its end, and `flush`, at most every COMMAND_FLUSH_MS, sends it to
 * the item. Until it passes MAX_COMMAND_OUTPUT only the new text goes, as an agent’s reply streams; past it, each
 * refresh replaces the whole text, so they’re rare and few, and the final flush always arrives.
 * @param {any} rt @param {string} threadId @param {string} itemId @param {string} note  the output’s first line
 */
export function commandOutput(rt, threadId, itemId, note) {
  let out = note; // the end of the output so far, at most twice the bound between flushes
  let sent = note.length; // characters already sent as item.text, before the output was cut
  let cut = false;
  let refreshed = 0; // refreshes of the item’s text since it was cut
  let refreshedAt = 0;
  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  const flush = ({ final = false } = {}) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!rt.store.pending.item(threadId, itemId)) return;
    if (!cut && out.length <= MAX_COMMAND_OUTPUT) {
      // Only the new text, as the reply of an agent streams.
      if (out.length > sent) rt.store.emit('item.text', { threadId, id: itemId, text: out.slice(sent) });
      sent = out.length;
      return;
    }
    cut = true;
    out = out.slice(-MAX_COMMAND_OUTPUT);
    // Past the bound, each refresh replaces the whole text, so they’re rare and few; the end always arrives.
    const now = Date.now();
    if (!final && (refreshed >= MAX_COMMAND_REFRESHES || now - refreshedAt < COMMAND_REFRESH_MS)) return;
    refreshed++;
    refreshedAt = now;
    rt.patchItem(threadId, itemId, { text: out, cut: true, ...(refreshed >= MAX_COMMAND_REFRESHES && !final ? { paused: true } : {}) });
  };
  /** @param {string} text */
  const add = (text) => {
    out += text;
    if (out.length > 2 * MAX_COMMAND_OUTPUT) {
      out = out.slice(-MAX_COMMAND_OUTPUT);
      cut = true;
    }
    if (!timer) {
      timer = setTimeout(flush, COMMAND_FLUSH_MS);
      timer.unref?.();
    }
  };
  return { add, flush, cut: () => cut, kept: () => out.length };
}

/**
 * Writes how a command ended, once writes are open: the output chunks are memory-only while closed (I1), but a
 * status left “running” in the recovered state would never end.
 * @param {any} rt @param {string} threadId @param {string} itemId
 * @param {{ run: any, cut: boolean, startedAt: number, exit: { code?: number|null, signal?: string|null, error?: any } }} end
 */
function endCommand(rt, threadId, itemId, { run, cut, startedAt, exit: { code = null, signal = null, error } }) {
  whenWritable(rt, () => {
    if (!rt.store.pending.item(threadId, itemId)) return;
    rt.patchItem(threadId, itemId, {
      status: run.stopped ? 'stopped' : error ? 'failed' : code === 0 ? 'done' : 'failed',
      exitCode: typeof code === 'number' ? code : null,
      signal: signal ?? null,
      ms: Date.now() - startedAt,
      ...(cut ? { paused: false } : {}),
      ...(run.closing ? { error: 'Postbox stopped it as it shut down.' } : error ? { error: clipText(String(error.message ?? error), 300) } : {}),
    });
  });
}

/** Sends the output of running commands that’s waiting for its next flush now (tests await this, not a timer). */
export function flushShellOutput(rt) {
  for (const run of rt.shellRuns.values()) run.flush();
}

/** Stop on a running `!command`: SIGINT, then SIGKILL. */
export function stopShellCommand(rt, threadId, itemId) {
  const it = rt.store.item(threadId, itemId);
  const run = rt.shellRuns.get(itemId);
  if (it?.kind !== 'command' || !run) throw httpError(409, 'That command already finished.');
  run.stopped = true;
  run.stop();
  return { ok: true };
}

/**
 * When Postbox shuts down: every running command, in its own process group, would outlive it. Each gets SIGINT,
 * and SIGKILL if it hasn’t ended within graceMs.
 * @param {any} rt @param {{ graceMs?: number }} [opts]
 */
export async function stopShellCommands(rt, { graceMs = 2000 } = {}) {
  const runs = [...rt.shellRuns.values()];
  if (!runs.length) return;
  for (const run of runs) {
    run.stopped = true;
    run.closing = true;
    run.stop();
  }
  /** @type {NodeJS.Timeout|undefined} */
  let timer;
  const late = new Promise((r) => {
    timer = setTimeout(r, graceMs);
  });
  await Promise.race([Promise.all(runs.map((r) => r.done)), late]);
  clearTimeout(timer);
  for (const run of runs) run.kill();
}

/**
 * After a restart, nothing Postbox started is running any more, unless Postbox stopped without shutting down (a crash),
 * which can leave a command running on its own. Either way its output here ends.
 */
export function expireStaleCommands(rt) {
  for (const [threadId, items] of Object.entries(rt.s.items))
    for (const it of items)
      if (it.kind === 'command' && it.status === 'running')
        rt.patchItem(threadId, it.id, {
          status: 'stopped',
          error: 'Postbox restarted while it ran. If Postbox didn’t shut down cleanly, it may still be running.',
        });
}
