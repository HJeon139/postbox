// The gate log of tools/signoff.mjs (#845): what `--run-gate` ran on a head, which step 5 reads back by default. CI’s
// required checks don’t include the two full browser runs, so a sign-off cites this log for them.
//
// It lives at <git common dir>/signoff/<head>.json: inside git’s own folder, so it’s never committed, and shared by
// every worktree of the clone, so a gate run in one worktree signs off the same head in another. Its shape:
//
//   { format: 1, writer: 'tools/signoff.mjs', head, startedAt, endedAt, clean: true,
//     node: { major, version }, load: { one, cores }, specs: [],
//     commands: [{ name, argv, env, code, ms }, …] }
//
// specs lists the spec files a run was limited to (--spec); empty means every spec ran. A log passes only when it is
// this script’s format, for this head, has every command in COMMANDS with exit code 0, ran on a Node major CI runs,
// and ran every spec.

import { join } from 'node:path';

export const FORMAT = 1;
export const WRITER = 'tools/signoff.mjs';

/**
 * The gate’s commands, in order: npm run check, then the browser specs plainly and with the server’s events 300 ms
 * late, as designs/developing.md, “Running the gate”, says. The plain run sets the lag empty, so one in this
 * shell’s environment doesn’t leak in; the server reads empty as no lag.
 * @param {string[]} specs
 * @returns {{ name: string, argv: string[], env: Record<string, string> }[]}
 */
export function commands(specs) {
  return [
    { name: 'check', argv: ['npm', 'run', 'check'], env: {} },
    { name: 'browser', argv: ['npx', 'playwright', 'test', ...specs], env: { POSTBOX_STREAM_LAG: '' } },
    { name: 'browser, events late', argv: ['npx', 'playwright', 'test', ...specs], env: { POSTBOX_STREAM_LAG: '300' } },
  ];
}

/** The log’s folder. @param {string} gitDir the clone’s common git folder */
export const logDir = (gitDir) => join(gitDir, 'signoff');

/** The log’s path for a head. @param {string} gitDir @param {string} head */
export const logPath = (gitDir, head) => join(logDir(gitDir), `${head}.json`);

/**
 * The newest other head that has a log, to name in the failure when this head has none.
 * @param {import('./deps.mjs').Deps} d @param {string} gitDir @param {string} head
 */
function otherLog(d, gitDir, head) {
  const dir = logDir(gitDir);
  if (!d.exists(dir)) return undefined;
  const logs = d.list(dir).filter((n) => /^[0-9a-f]{40}\.json$/.test(n) && n !== `${head}.json`);
  /** @type {{ head: string, endedAt: string } | undefined} */
  let newest;
  for (const name of logs) {
    try {
      const log = JSON.parse(d.readFile(join(dir, name)));
      if (!newest || String(log.endedAt) > newest.endedAt) newest = { head: name.slice(0, 8), endedAt: String(log.endedAt) };
    } catch {
      // A log that can’t be read names nothing here; this head’s own log is what’s missing.
    }
  }
  return newest;
}

/**
 * Reads this head’s log, or why there’s none to read.
 * @param {import('./deps.mjs').Deps} d @param {string} gitDir @param {string} head
 * @returns {{ log?: any, why?: string }}
 */
export function readLog(d, gitDir, head) {
  const path = logPath(gitDir, head);
  let text;
  try {
    text = d.readFile(path);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') return { why: `couldn’t read the gate log ${path}: ${e.message}` };
    const other = otherLog(d, gitDir, head);
    const also = other ? ` The newest gate log is for ${other.head}, another head.` : '';
    return { why: `no gate log for head ${head.slice(0, 8)}.${also} Run tools/signoff.mjs with --run-gate.` };
  }
  try {
    return { log: JSON.parse(text) };
  } catch (e) {
    return { why: `the gate log ${path} isn’t JSON: ${e.message}` };
  }
}

/**
 * Why a log doesn’t sign off head, or '' when it does.
 * @param {any} log @param {string} head @param {number[]} majors the Node majors CI runs
 */
export function verdict(log, head, majors) {
  if (log?.format !== FORMAT || log?.writer !== WRITER) return `the gate log isn’t ${WRITER}’s, format ${FORMAT}`;
  if (log.head !== head) return `the gate log is for ${String(log.head).slice(0, 8)}, not head ${head.slice(0, 8)}`;
  if (log.clean !== true) return 'the gate ran on a working tree with changes HEAD doesn’t have';
  if (!majors.includes(log.node?.major)) return `the gate ran on Node ${log.node?.version}; CI runs Node ${majors.join(' and ')}`;
  if (log.specs?.length) return `the browser runs were limited to ${log.specs.length} spec files: sign-off needs both full runs`;
  /** @type {{ name: string, code: number }[]} */
  const ran = Array.isArray(log.commands) ? log.commands : [];
  for (const { name } of commands([])) {
    const c = ran.find((r) => r.name === name);
    if (!c) return `the gate log has no “${name}” run`;
    if (c.code !== 0) return `“${name}” exited ${c.code}`;
  }
  return '';
}
