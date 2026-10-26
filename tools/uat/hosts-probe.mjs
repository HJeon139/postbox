// TCP listeners, before a host-mode run sets its hosts up and while its turns run (#120, “Done when”: no new TCP
// listener during a turn, on either machine). Here, `lsof`, with the run’s own processes being its Postbox and that
// server’s children (its ssh, a local agent’s CLI); on a host, `ss` over the runner’s ssh (tools/uat/hosts-ssh.mjs),
// with the run’s own being the processes in a session one of Postbox’s is in. A listener of another process is
// listed, not judged: a shared machine’s come and go. The parsers are pure.

import { spawnSync } from 'node:child_process';
import { hostListeners, measureOn, SCRIPTS } from './hosts-ssh.mjs';

/** `lsof -F pn`’s records: one { addr, pid } per listening address. @param {string} out */
export function parseLsof(out) {
  const found = [];
  let pid = null;
  for (const l of String(out ?? '').split('\n')) {
    if (l.startsWith('p')) pid = l.slice(1);
    else if (l.startsWith('n') && pid) found.push({ addr: l.slice(1), pids: [pid] });
  }
  return [...new Map(found.map((x) => [`${x.addr} ${x.pids[0]}`, x])).values()];
}

/** The processes under root (root too), from `ps -A -o pid=,ppid=`. @param {string} out @param {number} root */
export function treeOf(out, root) {
  const kids = new Map();
  for (const l of String(out ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(l);
    if (m) kids.set(m[2], [...(kids.get(m[2]) ?? []), m[1]]);
  }
  const seen = new Set([String(root)]);
  for (const p of seen) for (const k of kids.get(p) ?? []) seen.add(k);
  return seen;
}

/**
 * This computer’s listeners now, with which the run’s Postbox and its children hold. Throws when lsof or ps can’t say:
 * lsof exits 1 both when it found nothing and for an error, which it says on stderr (its warnings aside).
 * @param {number|undefined} root @param {{ run?: typeof spawnSync }} [o]
 */
export function localListeners(root, { run = spawnSync } = {}) {
  const lsof = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'], { encoding: 'utf8' });
  const complaints = String(lsof.stderr ?? '')
    .split('\n')
    .filter((l) => l.trim() && !/WARNING/.test(l));
  const none = lsof.status === 1 && !String(lsof.stdout ?? '').trim() && !complaints.length;
  if (lsof.error || (lsof.status !== 0 && !none))
    throw new Error(`Couldn’t read this computer’s listeners with lsof: ${lsof.error?.message ?? (String(lsof.stderr ?? '').trim() || `exit ${lsof.status}`)}`);
  const ps = run('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (ps.error || ps.status !== 0)
    throw new Error(`Couldn’t list this computer’s processes with ps: ${ps.error?.message ?? (String(ps.stderr ?? '').trim() || `exit ${ps.status}`)}`);
  return Object.assign(parseLsof(lsof.stdout), { run: root ? treeOf(ps.stdout, root) : new Set() });
}

/** A host’s listeners now. Throws when ss or ps there couldn’t say. @param {string} destination */
export async function remoteListeners(destination) {
  const { out, why } = await measureOn(destination, SCRIPTS.listeners);
  if (out === null) throw new Error(`Couldn’t read the listeners on the host: ${why}`);
  return hostListeners(out);
}

/**
 * What listens now that didn’t before: every new address, and those the run’s own processes hold.
 * @param {string[]} baseline  the addresses before setup @param {{ addr: string, pids: string[] }[] & { run?: Set<string> }} now
 */
export function newListeners(baseline, now) {
  const before = new Set(baseline);
  const added = now.filter((x) => !before.has(x.addr));
  const label = (x) => `${x.addr}${x.pids.length ? ` (pid ${x.pids.join(', ')})` : ''}`;
  return { added: added.map(label), run: added.filter((x) => x.pids.some((p) => now.run?.has(p))).map(label) };
}

/** The addresses that listen, for a baseline. @param {{ addr: string }[]} now */
export const addrs = (now) => [...new Set(now.map((x) => x.addr))];
