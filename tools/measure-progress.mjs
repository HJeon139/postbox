// How much of the event log a running turn’s progress is, what it costs on the wire, and what a restart does
// (designs/architecture/live-progress.md, “Why” and “Proving it costs nothing new”). It changes nothing: the
// live-only progress work records main’s numbers with it before any change, and each pull request compares against
// them, back to back on the same machine.
//
//   node tools/measure-progress.mjs [backends|long|crowded|restart ...] [--runs N]
//
// Each section runs N times (3 unless --runs says), each in a fresh process (tools/measure-progress/run.mjs), on a
// virtual clock, and every number is printed as its band: the least, the median and the most of the runs. The log is
// counted as the store writes it, in UTF-8 bytes (tools/measure-progress/log-bytes.mjs).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUN = new URL('./measure-progress/run.mjs', import.meta.url).pathname;
const argv = process.argv.slice(2);
const runsAt = argv.indexOf('--runs');
const RUNS = runsAt >= 0 ? Number(argv[runsAt + 1]) : 3;
const asked = argv.filter((a, i) => !a.startsWith('--') && i !== runsAt + 1);
const SECTIONS = ['backends', 'long', 'crowded', 'restart'].filter((s) => !asked.length || asked.includes(s));

/**
 * One run of a section in a fresh process: its rows, or null when it was killed as asked. A run that fails stops the
 * measurement, with its output. @param {string[]} args @param {{ killed?: boolean }} [o]
 */
function run(args, { killed = false } = {}) {
  const r = spawnSync(process.execPath, ['--expose-gc', RUN, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (killed && r.signal === 'SIGKILL') return null;
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  if (r.status !== 0 || !line) throw new Error(`${args.join(' ')} failed (${r.status ?? r.signal}):\n${r.stderr}\n${r.stdout}`);
  return JSON.parse(line.slice('RESULT '.length));
}

/** Derived numbers: the shares of the log, and the event loop’s time a delta. @param {Record<string, any>} r */
function derived(r) {
  if (!('logBytes' in r) || !('progressBytes' in r)) return r;
  return {
    ...r,
    progressPct: (100 * r.progressBytes) / r.logBytes,
    mixedPct: (100 * r.mixedBytes) / r.logBytes,
    usPerDelta: r.pushes ? (1000 * r.pushMs) / r.pushes : 0,
  };
}

/** Each row’s numbers across the runs. @param {any[][]} runs */
function bands(runs) {
  /** @type {Map<string, Record<string, number[]>>} */
  const rows = new Map();
  for (const rs of runs)
    for (const r of rs) {
      const row = rows.get(r.row) ?? {};
      for (const [k, v] of Object.entries(derived(r))) if (typeof v === 'number') (row[k] ??= []).push(v);
      rows.set(r.row, row);
    }
  return rows;
}

/** A band as text: one number when every run gave it, else the least, the median and the most. @param {number[]} xs */
function band(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const f = (/** @type {number} */ x) => (Number.isInteger(x) ? String(x) : x.toFixed(x < 10 ? 2 : 1));
  const [lo, mid, hi] = [s[0], s[Math.floor(s.length / 2)], s.at(-1)];
  return lo === hi ? f(lo) : `${f(lo)} | ${f(mid)} | ${f(hi)}`;
}

/** Prints a section’s rows. @param {string} title @param {any[][]} runs */
function print(title, runs) {
  console.log(`\n## ${title} (${runs.length} runs; a band is least | median | most)`);
  for (const [row, nums] of bands(runs)) {
    console.log(`- ${row}`);
    for (const [k, xs] of Object.entries(nums)) console.log(`    ${k}: ${band(xs)}`);
  }
}

/** The restart section: each scale and way of stopping, built and loaded in processes of their own. */
function restart() {
  /** @type {any[][]} */
  const runs = Array.from({ length: RUNS }, () => []);
  for (const agents of ['4', '40', '400'])
    for (const mode of ['graceful', 'crash'])
      for (let i = 0; i < RUNS; i++) {
        const dir = mkdtempSync(join(tmpdir(), 'pb-measure-restart-'));
        try {
          const built = run(['restart-build', dir, agents, mode], { killed: mode === 'crash' });
          if (built) runs[i].push(...built);
          runs[i].push(...run(['restart-load', dir, agents, mode]));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
  print('Restart mid-turn: 1x, 10x and 100x agents in rooms of 4, half of each turn run', runs);
}

for (const section of SECTIONS) {
  if (section === 'restart') restart();
  else
    print(
      section,
      Array.from({ length: RUNS }, () => run([section])),
    );
}
