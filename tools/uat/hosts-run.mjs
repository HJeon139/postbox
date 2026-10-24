// A UAT run’s host mode (#120): the runner (tools/uat-run.mjs) with agents on other machines over ssh. This module
// holds the run’s record of its hosts (facts.hosts, tools/uat/remote-facts.mjs) and sets them up the way a person
// would, through the UI (tools/uat/driver-hosts.mjs): add each host, set its settings and the project’s folder there,
// Install with its confirm, connect, and put each agent on its host in its persona’s Runs on. Before that, it reads
// what listens and what runs on each machine, so the end-of-run checks (tools/uat/hosts-end.mjs) have a baseline.
// While the run goes on, tools/uat/hosts-watch.mjs samples it and does the faults the tester asks for.

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { addHost, closeAll, editHost, install, placePersona } from './driver-hosts.mjs';
import { addrs, localListeners, remoteListeners } from './hosts-probe.mjs';
import { launcherScript, linesOf, measureOn, onHost, processesOf, SCRIPTS, UUID, workScript } from './hosts-ssh.mjs';

/**
 * @typedef {{ label: string, destination: string, settings: Record<string, any>, id: string|null, home: string|null,
 *   made: { parent: boolean } | null }} RunHost  made: the run made its folder there (and ~/postbox-uat too, if parent)
 * @typedef {{ hosts: RunHost[], placement: Record<string, string>, launcher: string|null, root: string, stamp: string,
 *   log: (line: string) => void, record: any, postbox: any, kit: any, api: (p: string) => Promise<any>, samples: Map<string, any>,
 *   trees: Map<string, Map<string, import('./hosts-ssh.mjs').HostProc>>, cleaning?: Promise<void>, ending?: Promise<void>,
 *   starting?: Promise<void> }} HostRun
 *   trees: every process seen under each host turn (hosts-watch.mjs), by “PID start”
 */

/**
 * The run’s hosts, from its options (tools/uat/hosts-options.mjs), before anything is set up.
 * @param {{ hosts: { label: string, destination: string, settings: Record<string, any> }[], placement: Record<string, string>,
 *   launcher: string|null, root: string, stamp: string, data: string, log: (line: string) => void }} o
 * @returns {HostRun}
 */
export function createHostRun({ hosts, placement, launcher, root, stamp, data, log }) {
  const list = hosts.map((h) => ({ ...h, id: null, home: null, made: null }));
  return {
    hosts: list,
    placement,
    launcher,
    root,
    stamp,
    log,
    postbox: null,
    kit: null,
    api: async () => ({}),
    samples: new Map(),
    trees: new Map(),
    record: {
      hosts: list.map((h) => ({ label: h.label, destination: h.destination, id: null })),
      placement,
      laptopData: data,
      setup: [],
      listeners: { baseline: {}, samples: [] },
      stops: [],
      faults: [],
      before: {},
    },
  };
}

/** Runs a script on a host, or throws with what ssh said. @param {RunHost} h @param {string} script */
export async function must(h, script) {
  const r = await onHost(h.destination, script);
  if (r.code !== 0) throw new Error(`The runner’s ssh to ${h.label} failed (exit ${r.code}): ${r.stderr || r.stdout.slice(-300)}`);
  return r.stdout;
}

/** A measuring script’s output on a host, or throws: what it measures with is missing, or ssh failed. @param {RunHost} h @param {string} script */
async function measure(h, script) {
  const { out, why } = await measureOn(h.destination, script);
  if (out === null) throw new Error(`The runner couldn’t measure on ${h.label} (${h.destination}): ${why}`);
  return out;
}

/**
 * Before setup: what the run measures with on each host, what listens here and there, and what of Postbox already
 * runs there. A host without pgrep, pkill, ps, ss or sed stops the run, since its checks would read nothing as
 * nothing there. A host where Postbox’s daemon already runs is another Postbox’s, and the run won’t take it over.
 * @param {HostRun} hr
 */
export async function baseline(hr) {
  hr.record.listeners.baseline.local = addrs(localListeners(hr.postbox?.pid));
  for (const h of hr.hosts) {
    const missing = linesOf(await measure(h, SCRIPTS.preflight)).map((l) => l.replace(/^missing /, ''));
    if (missing.length)
      throw new Error(
        `${h.label} (${h.destination}) has no ${missing.join(', ')} on its PATH, which the run’s checks there need. Install it there, or leave the host out.`,
      );
    h.home = (await must(h, SCRIPTS.home)).trim();
    const running = processesOf(await measure(h, SCRIPTS.processes));
    if (running.length)
      throw new Error(
        `Postbox already runs on ${h.label} (${h.destination}), so another Postbox may be using it: ${running.slice(0, 3).join('; ')}. Stop it there first.`,
      );
    hr.record.before[h.label] = linesOf(await must(h, SCRIPTS.turns)).filter((t) => UUID.test(t));
    hr.record.listeners.baseline[h.label] = addrs(await remoteListeners(h.destination));
    hr.log(`${h.label}: home ${h.home}, ${hr.record.listeners.baseline[h.label].length} TCP listeners, ${hr.record.before[h.label].length} turns from before.`);
  }
}

/**
 * P0’s launcher on the host, in front of its Claude Code, and the host’s claudePath pointed at it (through the UI).
 * Node’s and Claude Code’s paths there are the host’s settings, or what the runner’s ssh finds: Postbox’s own welcome
 * comes only with the first turn, since nothing connects to an idle host.
 * @param {HostRun} hr @param {RunHost} h
 */
async function putLauncher(hr, h) {
  const found = Object.fromEntries(
    linesOf(await must(h, SCRIPTS.programs))
      .map((l) => l.split(/ (.*)/s).slice(0, 2))
      .reverse(),
  );
  const node = h.settings.nodePath ?? found.node;
  const real = h.settings.claudePath ?? found.claude;
  if (!node || !real)
    throw new Error(
      `P0’s launcher needs Node and Claude Code on ${h.label}, and the runner found ${node ? 'no Claude Code' : 'no Node'} there. Pass --host-setting ${h.label}.${node ? 'claudePath' : 'nodePath'}=<its path there>.`,
    );
  const launcher = readFileSync(resolve(hr.root, /** @type {string} */ (hr.launcher)), 'utf8');
  const wrapper = (await must(h, launcherScript({ launcher, node, claude: real, run: hr.stamp }))).trim();
  await editHost(hr.kit, /** @type {string} */ (h.id), { claudePath: wrapper });
  hr.log(`${h.label}: P0’s launcher at ${wrapper}, run by ${node}, in front of ${real}.`);
  return wrapper;
}

/**
 * Makes the run’s own folder on a host (workScript). It counts as the run’s before the script runs, so a folder made
 * by a script whose reply ssh lost is still cleanUp’s to remove; only workScript’s refusal of one that was there
 * already (exit 3) says it isn’t. ~/postbox-uat counts as the run’s only once the script says it made it.
 * @param {HostRun} hr @param {RunHost} h @param {{ run?: typeof onHost }} [o]
 */
export async function makeRunFolder(hr, h, { run = onHost } = {}) {
  h.made = { parent: false };
  const r = await run(h.destination, workScript(hr.stamp));
  if (r.code === 3) h.made = null;
  if (r.code !== 0) throw new Error(`The runner’s ssh to ${h.label} failed (exit ${r.code}): ${r.stderr || r.stdout.slice(-300)}`);
  h.made = { parent: linesOf(r.stdout).includes('made') };
}

/**
 * Sets one host up through the UI, and records what it showed. It connects with its first turn: an installed host
 * that nothing needs offers no Connect, and the manager connects only for a turn or a prompt (afterStep fails the
 * run with the host’s own message if it doesn’t).
 * @param {HostRun} hr @param {RunHost} h @param {string} projectId
 */
async function setUpHost(hr, h, projectId) {
  h.id = await addHost(hr.kit, h.destination);
  /** @type {any} */ (hr.record.hosts.find((x) => x.label === h.label)).id = h.id;
  await makeRunFolder(hr, h);
  await editHost(hr.kit, h.id, h.settings, { project: projectId, folder: `${h.home}/postbox-uat/${hr.stamp}/work` });
  const shown = await install(hr.kit, h.id);
  hr.log(`${h.label}: ${shown.installOffered ? 'Install…' : 'no Install… on its card, so the runner opened the confirm'}; it said: ${shown.confirm}`);
  const placed = Object.values(hr.placement).includes(h.label);
  const launcher = hr.launcher && placed ? await putLauncher(hr, h) : null;
  hr.record.setup.push({ label: h.label, ...shown, launcher, card: shown.card });
}

/**
 * Sets every host up, then puts each placed agent on its host. A run that’s stopping (cleanUp, tools/uat/hosts-end.mjs)
 * sets nothing more up: its cleanup waits for this, so what this already set up is removed.
 * @param {HostRun} hr @param {string} projectId
 */
export async function setUp(hr, projectId) {
  const going = () => {
    if (hr.cleaning) throw new Error('The run is stopping, so it sets no more hosts up.');
  };
  for (const h of hr.hosts) {
    going();
    await setUpHost(hr, h, projectId);
  }
  for (const [handle, label] of Object.entries(hr.placement)) {
    going();
    if (label === 'local') continue;
    await placePersona(hr.kit, handle, hr.hosts.find((h) => h.label === label)?.id ?? null);
    hr.log(`@${handle} runs on ${label}.`);
  }
  await closeAll(hr.kit);
}

/**
 * Host mode’s start, once the run’s Postbox, page and project are there: the baseline, then each host set up.
 * @param {HostRun} hr @param {{ postbox: any, api: (p: string) => Promise<any>, kit: any, dir: string, project: string }} o
 */
export async function startHosts(hr, { postbox, api, kit, dir, project }) {
  Object.assign(hr, { postbox, api, kit });
  hr.starting = (async () => {
    await baseline(hr);
    const pr = Object.values((await api('/api/state')).state?.projects ?? {}).find((p) => p.name === project);
    if (!pr) throw new Error(`The project “${project}” wasn’t made, so the hosts can’t have its folder.`);
    await setUp(hr, pr.id);
  })();
  await hr.starting;
  await saveHosts(hr, dir);
}

/** The run’s record of its hosts, for --recheck. @param {HostRun} hr @param {string} dir */
export const saveHosts = (hr, dir) => writeFile(join(dir, 'hosts.json'), `${JSON.stringify(hr.record, null, 2)}\n`);

/** A finished run’s record of its hosts, or null for a run without any. @param {string} dir */
export function readHosts(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'hosts.json'), 'utf8'));
  } catch {
    return null;
  }
}
