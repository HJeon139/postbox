// A host-mode run while it goes on (#120; tools/uat/hosts-run.mjs has the record it adds to):
// - sample(): while agents work, what Stop says beforehand for an agent on a host with background jobs; at most every
//   5 s per host, every process under each turn’s runner there (hosts-ssh.mjs, turnTrees), and beforeStop() once
//   more just before the runner presses Stop; and, at most once a minute per machine, what listens
//   (tools/uat/hosts-probe.mjs);
// - afterStep(): after each step, a Stop on an agent on a host, and which of the processes seen under its turn still
//   run there, by PID and start time, or by the group or session they were in: Claude Code’s tool shells lead
//   sessions of their own, and outlive a killed CLI as children of PID 1, so neither the runner’s session nor the
//   turn’s ID in a command line finds them. A Stop with nothing seen under its turn beforehand can’t be judged, and
//   says so;
// - fault(): what the tester breaks on purpose, kill-ssh, kill-daemon or restart-postbox, and what Postbox showed
//   after, until each host it touched reads Connected again or 3 minutes pass (tools/uat/hosts-recovery.mjs); for
//   kill-ssh, also which processes it killed.

import { spawnSync } from 'node:child_process';
import { sleep } from '../browser.mjs';
import { localListeners, newListeners, remoteListeners, treeOf } from './hosts-probe.mjs';
import { recovery, says } from './hosts-recovery.mjs';
import { leftInFolder, measureOn, onHost, parseTree, SCRIPTS, stillRunning, treeScript, turnTrees } from './hosts-ssh.mjs';
import { remoteTurns } from './remote-facts.mjs';

const BUSY = new Set(['think', 'tool', 'gen']);
const LISTENER_EVERY_MS = 60_000;
const LISTENER_SAMPLES = 5;
/** After Stop, the daemon’s grace before SIGKILL is 10 s; the probe waits past it. */
const STOP_SETTLED_MS = 15_000;
const TREE_EVERY_MS = 5000;

/** @typedef {import('./hosts-run.mjs').HostRun} HostRun */

const sessionsOf = (st, handle) => Object.values(st?.sessions ?? {}).filter((se) => se?.handle === handle);
const runningJobs = (st, handle) => sessionsOf(st, handle).flatMap((se) => (se.jobs ?? []).filter((j) => j.state === 'running' && !j.kept)).length;

/** What listens on one machine now, against its baseline, if it’s time for another sample. @param {HostRun} hr */
async function listenersNow(hr, where) {
  const last = hr.samples.get(where);
  if ((last?.n ?? 0) >= LISTENER_SAMPLES || Date.now() - (last?.at ?? 0) < LISTENER_EVERY_MS) return;
  hr.samples.set(where, { n: (last?.n ?? 0) + 1, at: Date.now() });
  const h = hr.hosts.find((x) => x.label === where);
  const now = h ? await remoteListeners(h.destination) : localListeners(hr.postbox?.pid);
  const diff = newListeners(hr.record.listeners.baseline[where] ?? [], now);
  hr.record.listeners.samples.push({ where, at: Date.now(), ...diff });
  if (diff.added.length)
    hr.log(`${where}: new TCP listeners during a turn: ${diff.added.join(', ')}${diff.run.length ? ` (the run’s own: ${diff.run.join(', ')})` : ''}.`);
}

/**
 * While agents work: the stop note and the jobs of each agent on a host, and the listeners where agents work.
 * @param {HostRun} hr @param {any} st  Postbox’s state now
 */
export async function sample(hr, st) {
  const notes = await hr.kit.ev(`[...document.querySelectorAll('.stop-note')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim())`).catch(() => []);
  const busy = (h) => sessionsOf(st, h).some((se) => BUSY.has(se.state));
  for (const [handle, where] of Object.entries(hr.placement)) {
    if (where === 'local' || !busy(handle)) continue;
    const note = (notes ?? []).find((n) => n.includes(`@${handle}’s`)) ?? null;
    hr.samples.set(`stop:${handle}`, { at: Date.now(), note, jobs: runningJobs(st, handle) });
  }
  const places = new Set(
    Object.entries(hr.placement)
      .filter(([h]) => busy(h))
      .map(([, w]) => w),
  );
  for (const where of places)
    await listenersNow(hr, where).catch((e) => {
      // A measurement that couldn’t be made is a finding (checks-remote.mjs), never a sample with nothing new.
      hr.record.listeners.samples.push({ where, at: Date.now(), error: e.message });
      hr.log(`Couldn’t read ${where}’s listeners: ${e.message}`);
    });
  for (const h of hr.hosts) if (places.has(h.label)) await watchTrees(hr, h);
}

/**
 * Adds what runs under each turn’s runner on a host to what the run has seen there, at most every 5 s unless now.
 * Each process is kept by PID and start time, so one that outlives its parent is still known.
 * @param {HostRun} hr @param {import('./hosts-run.mjs').RunHost} h @param {{ now?: boolean, measure?: typeof measureOn }} [o]
 * @returns {Promise<{ ok: boolean, why: string|null }>}
 */
async function watchTrees(hr, h, { now = false, measure = measureOn } = {}) {
  const key = `tree:${h.label}`;
  if (!now && Date.now() - (hr.samples.get(key) ?? 0) < TREE_EVERY_MS) return { ok: true, why: null };
  hr.samples.set(key, Date.now());
  const { out, why } = await measure(h.destination, SCRIPTS.tree);
  let trees;
  try {
    if (out === null) throw new Error(why ?? '');
    trees = turnTrees(parseTree(out));
  } catch (e) {
    hr.log(`Couldn’t list the turns’ processes on ${h.label}: ${e.message}`);
    return { ok: false, why: e.message };
  }
  for (const [turn, procs] of trees) {
    const seen = hr.trees.get(turn) ?? new Map();
    for (const p of procs) seen.set(`${p.pid} ${p.start}`, p);
    hr.trees.set(turn, seen);
  }
  return { ok: true, why: null };
}

/**
 * Just before the runner presses Stop: what runs under each turn on every host an agent is on, and whether that look
 * worked. A Stop after a look that failed can’t be judged from older ones (leftBy), since what started since is
 * unknown, until a later look before Stop works.
 * @param {HostRun|null} hr @param {{ measure?: typeof measureOn }} [o]
 */
export async function beforeStop(hr, { measure = measureOn } = {}) {
  if (!hr) return;
  const placed = new Set(Object.values(hr.placement));
  for (const h of hr.hosts) if (placed.has(h.label)) hr.samples.set(`forced:${h.label}`, await watchTrees(hr, h, { now: true, measure }));
}

/**
 * Each host’s first Connected, with what its daemon found there, and a host that failed before it ever connected: the
 * run stops there, with the host’s own message. An installed host first connects with its first turn.
 * @param {HostRun} hr @param {any} st
 */
function hostsUp(hr, st) {
  for (const h of hr.hosts) {
    const s = st?.hostStatus?.[/** @type {string} */ (h.id)];
    const setup = hr.record.setup.find((x) => x.label === h.label);
    if (s?.state === 'connected' && s.welcome && setup && !setup.connected) {
      const claude = (s.welcome.harnesses ?? []).find((x) => x.name === 'claude-code');
      setup.connected = {
        at: Date.now(),
        node: s.welcome.node ?? null,
        claude: claude ? { path: claude.path, version: claude.version } : null,
        problems: s.welcome.problems ?? [],
      };
      hr.log(`${h.label}: Connected; Node ${s.welcome.node?.version ?? '?'}, Claude Code ${claude?.version ?? 'not found'} at ${claude?.path ?? '?'}.`);
    }
    // Once a host has connected, a failure is what a check or a fault records, and the run goes on.
    if ((s?.state === 'failed' || s?.state === 'not-installed') && !setup?.connected)
      throw new Error(
        `${h.label} (${h.destination}) ${s.state === 'failed' ? 'failed' : 'reads not installed'}: ${[s.failure?.message, s.failure?.next].filter(Boolean).join(' ') || 'no message'}`,
      );
  }
}

/**
 * After a step: each Stop on an agent on a host not yet looked at, with what Stop said before it, and what of the
 * turn still runs on the host once the daemon’s grace has passed.
 * @param {HostRun} hr @param {any} facts
 */
export async function afterStep(hr, facts) {
  hostsUp(hr, facts.state);
  const recs = remoteTurns(facts);
  const seen = new Set(hr.record.stops.map((x) => x.turnId));
  for (const t of facts.threads ?? [])
    for (const it of facts.state?.items?.[t] ?? []) {
      const where = hr.placement[it.handle];
      if (it.kind !== 'agent' || it.status !== 'stopped' || !where || where === 'local' || seen.has(it.turnId)) continue;
      seen.add(it.turnId);
      const rec = recs.get(it.turnId);
      const h = hr.hosts.find((x) => x.label === where);
      const before = hr.samples.get(`stop:${it.handle}`) ?? {};
      const x = {
        handle: it.handle,
        label: where,
        turnId: it.turnId,
        turn: rec?.turn ?? null,
        at: it.stoppedAt ?? null,
        note: before.note ?? null,
        jobs: before.jobs ?? 0,
        ...(await leftBy(hr, h, rec?.turn, it.stoppedAt)),
      };
      hr.record.stops.push(x);
      hr.log(
        `Stop on @${it.handle} (${where}): ${x.jobs} jobs; ${x.left === null ? `couldn’t tell what was left: ${x.unmeasured}` : x.left.length ? `left running: ${x.left.join('; ')}` : `none of the ${x.watched} processes seen under the turn left on the host`}.`,
      );
    }
}

/**
 * What of a stopped host turn still runs once the daemon’s grace has passed: which processes seen under it do, or
 * null and why it can’t be told, as when the last look at the host before Stop failed or there was none.
 * @param {HostRun} hr @param {import('./hosts-run.mjs').RunHost|undefined} h @param {string|undefined} turn @param {number|undefined} stoppedAt
 * @param {{ measure?: typeof measureOn, wait?: (ms: number) => Promise<unknown> }} [o]
 * @returns {Promise<{ watched: number, left: string[]|null, unmeasured?: string }>}
 */
export async function leftBy(hr, h, turn, stoppedAt, { measure = measureOn, wait = sleep } = {}) {
  if (!h || !turn) return { watched: 0, left: null, unmeasured: 'Postbox recorded no turn on a host for it.' };
  const seen = [...(hr.trees.get(turn)?.values() ?? [])];
  const forced = hr.samples.get(`forced:${h.label}`);
  if (!forced?.ok)
    return {
      watched: seen.length,
      left: null,
      unmeasured: forced
        ? `the look at the host just before Stop failed (${forced.why}), so what started since is unknown.`
        : 'nothing looked at the host just before Stop.',
    };
  if (!seen.length) return { watched: 0, left: null, unmeasured: 'nothing was seen running under the turn before Stop.' };
  await wait(Math.max(0, (stoppedAt ?? 0) + STOP_SETTLED_MS - Date.now()));
  const { out, why } = await measure(h.destination, treeScript(hr.stamp));
  try {
    if (out === null) throw new Error(why ?? '');
    const now = parseTree(out);
    // What was seen under the turn, and anything still running in the run’s folder that no live turn has.
    const left = new Map([...stillRunning(seen, now), ...leftInFolder(now)].map((p) => [p.pid, `${p.pid} ${p.args}`]));
    return { watched: seen.length, left: [...left.values()] };
  } catch (e) {
    return { watched: seen.length, left: null, unmeasured: `the host’s processes couldn’t be listed: ${e.message}` };
  }
}

/** The agents’ rows in the sidebar, for the agents on these hosts. @param {HostRun} hr @param {string[]} labels */
const rowsOf = (hr, labels) =>
  hr.kit
    .ev(`[...document.querySelectorAll('.agent-rows .agent-btn')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim())`)
    .then((rows) => (rows ?? []).filter((r) => Object.entries(hr.placement).some(([h, w]) => labels.includes(w) && r.includes(`@${h}`))))
    .catch(() => []);

/** Kills the run’s Postbox’s ssh to a host, and says which processes. @param {HostRun} hr @param {import('./hosts-run.mjs').RunHost} h */
function killSsh(hr, h) {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' }).stdout;
  const mine = treeOf(ps, hr.postbox.pid);
  const ssh = ps
    .split('\n')
    .map((l) => /^\s*(\d+)\s+\d+\s+(.*)$/.exec(l))
    .filter((m) => m && mine.has(m[1]) && /^(?:\S*\/)?ssh\s/.test(m[2]) && m[2].split(/\s+/).includes(h.destination));
  for (const m of ssh) process.kill(Number(m?.[1]), 'SIGKILL');
  return ssh.map((m) => `${m?.[1]} ${String(m?.[2]).slice(0, 160)}`);
}

/**
 * Does one fault, and records what Postbox showed after. Returns what to tell the tester.
 * @param {HostRun} hr @param {{ fault: string, target?: string }} spec @param {{ reload: () => Promise<void> }} page
 */
export async function fault(hr, { fault: kind, target }, page) {
  if (kind === 'restart-postbox') return restart(hr, page);
  const h = hr.hosts.find((x) => x.label === target);
  if (!h) throw new Error(`${kind} needs a target: ${hr.hosts.map((x) => x.label).join(' or ')}.`);
  const at = Date.now();
  let hit;
  /** @type {string[]} */
  let killed = [];
  if (kind === 'kill-ssh') hit = (killed = killSsh(hr, h)).length;
  else if (kind === 'kill-daemon') {
    const r = await onHost(h.destination, SCRIPTS.killDaemon);
    if (r.code !== 0) throw new Error(`Couldn’t kill Postbox’s daemon on ${h.label}: ${r.stderr || `pkill exited ${r.code}`}`);
    hit = r.stdout.trim() === 'killed' ? 1 : 0;
  } else throw new Error(`A fault is kill-ssh, kill-daemon or restart-postbox, not “${kind}”.`);
  const what = kind === 'kill-ssh' ? `Postbox’s ssh to ${h.label}` : `Postbox’s daemon on ${h.label}`;
  if (!hit) {
    hr.record.faults.push({ fault: kind, label: h.label, at, states: [], recovered: null, shown: `There was no ${what} to kill.` });
    return `There was no ${what} to kill, so nothing happened.`;
  }
  const r = await recovery(hr, h, at);
  const shown = says(h.label, r, await rowsOf(hr, [h.label]));
  hr.record.faults.push({ fault: kind, label: h.label, at, ...r, shown, ...(killed.length ? { killed } : {}) });
  hr.log(`fault ${kind} on ${h.label}: ${shown}`);
  return `Killed ${what}. ${shown}`;
}

/** Stops Postbox and starts it on the same data, reloads the page, and follows each host that was connected. */
async function restart(hr, page) {
  const at = Date.now();
  const before = (await hr.api('/api/state')).state?.hostStatus ?? {};
  const was = hr.hosts.filter((h) => before[/** @type {string} */ (h.id)]?.state === 'connected');
  const downMs = await hr.postbox.restart();
  await page.reload();
  const results = [];
  for (const h of was) results.push([h, await recovery(hr, h, Date.now())]);
  const recovered = was.length ? results.every(([, r]) => r.recovered !== false) : null;
  const rows = await rowsOf(
    hr,
    was.map((h) => h.label),
  );
  const shown = `Postbox was down ${(downMs / 1000).toFixed(1)} s. ${results.map(([h, r]) => says(h.label, r, [])).join(' ') || 'No host was connected.'}${rows.length ? ` The sidebar: ${rows.map((r) => `“${r}”`).join('; ')}.` : ''}`;
  hr.record.faults.push({
    fault: 'restart-postbox',
    label: null,
    at,
    recovered,
    shown,
    states: results.flatMap(([h, r]) => r.states.map((s) => ({ ...s, host: h.label }))),
  });
  hr.log(`fault restart-postbox: ${shown}`);
  return `Restarted Postbox on the same data. ${shown}`;
}
