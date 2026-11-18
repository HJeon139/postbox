// How much of the event log a running turn’s progress is, what it costs on the wire, and what a restart does
// (designs/architecture/live-progress.md, “Why” and “Proving it costs nothing new”). It changes nothing: the
// live-only progress work records main’s numbers with it before any change, and each pull request compares against
// them, back to back on the same machine.
//
//   node tools/measure-progress.mjs [backends|long|crowded|steady|joining|restart ...] [--runs N]
//   node tools/measure-progress.mjs [sections ...] --against <main's checkout> [--pairs N]
//
// Each section runs N times (3 unless --runs says), each in a fresh process (tools/measure-progress/run.mjs), on a
// virtual clock, and every number is printed as its band: the least, the median and the most of the runs. The log is
// counted as the store writes it, in UTF-8 bytes (tools/measure-progress/log-bytes.mjs). With --against, the runs of
// that checkout’s tool and this one’s alternate in N pairs (8 unless --pairs says), and each number gets a verdict
// against it (tools/measure-progress/compare.mjs); a section with a number worse runs a second round, which must agree.
// `steady` runs each crowd in a process of its own, warmed before it’s measured (tools/measure-progress/steady.mjs):
// the time a long-running Postbox pays, where `crowded` reads a cold process’s.

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, mainFirst, sameShape, UNGATED_TIMES, worseTwice } from './measure-progress/compare.mjs';

const OWN = new URL('./measure-progress/run.mjs', import.meta.url).pathname;
const { removeRestart } = await import('./measure-progress/restart.mjs');
const { STEADY_CROWDS } = await import('./measure-progress/steady.mjs');
const argv = process.argv.slice(2);
/** A flag’s value, or undefined. @param {string} name */
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const RUNS = Number(flag('--runs') ?? 3);
const PAIRS = Number(flag('--pairs') ?? 8);
const AGAINST = flag('--against');
const asked = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const SECTIONS = ['backends', 'long', 'crowded', 'steady', 'joining', 'restart'].filter((s) => !asked.length || asked.includes(s));

/**
 * One run of a section in a fresh process, by the tool at `script`: its rows, or null when it was killed as asked. A
 * run that fails stops the measurement, with its output. @param {string} script @param {string[]} args
 * @param {{ killed?: boolean }} [o]
 */
function run(script, args, { killed = false } = {}) {
  const r = spawnSync(process.execPath, ['--expose-gc', script, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (killed && r.signal === 'SIGKILL') return null;
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  if (r.status !== 0 || !line) throw new Error(`${script} ${args.join(' ')} failed (${r.status ?? r.signal}):\n${r.stderr}\n${r.stdout}`);
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
      for (const [k, v] of Object.entries(r)) if (typeof v === 'number') (row[k] ??= []).push(v);
      rows.set(r.row, row);
    }
  return rows;
}

/** A number as text. @param {number} x */
const f = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(x < 10 ? 2 : 1));

/** A band as text: one number when every run gave it, else the least, the median and the most. @param {number[]} xs */
function band(xs) {
  const s = [...xs].sort((a, b) => a - b);
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

/** One run of the restart section by the tool at `script`: each scale and way of stopping, built and loaded apart. @param {string} script */
function restartOnce(script) {
  const rows = [];
  for (const agents of ['4', '40', '400'])
    for (const mode of ['graceful', 'crash']) {
      const dir = mkdtempSync(join(tmpdir(), 'pb-measure-restart-'));
      try {
        const built = run(script, ['restart-build', dir, agents, mode], { killed: mode === 'crash' });
        if (built) rows.push(...built);
        rows.push(...run(script, ['restart-load', dir, agents, mode]));
      } finally {
        removeRestart(dir);
      }
    }
  return rows;
}

/** One run of the steady section by the tool at `script`: each crowd in a process of its own. @param {string} script */
const steadyOnce = (script) => STEADY_CROWDS.flatMap((_, i) => run(script, ['steady-one', String(i)]));

/** One run of a section by the tool at `script`, its derived numbers added. @param {string} script @param {string} section */
function once(script, section) {
  if (section === 'restart') return restartOnce(script).map(derived);
  if (section === 'steady') return steadyOnce(script).map(derived);
  return run(script, [section]).map(derived);
}

/** Runs of main’s tool and this one in PAIRS pairs, ABBA. @param {string} theirs @param {string} section */
function pairs(theirs, section) {
  /** @type {any[][]} */ const main = [];
  /** @type {any[][]} */ const branch = [];
  for (let i = 0; i < PAIRS; i++) {
    if (mainFirst(i)) main.push(once(theirs, section));
    branch.push(once(OWN, section));
    if (!mainFirst(i)) main.push(once(theirs, section));
    if (i === 0) sameShape(main, branch); // a mismatch stops here, not after every pair
  }
  return compare(main, branch, { times: !UNGATED_TIMES.has(section) });
}

/** Prints a round’s numbers against main’s. @param {string} title @param {ReturnType<typeof compare>} round */
function printRound(title, round) {
  console.log(`\n## ${title}`);
  let row = '';
  for (const c of round) {
    if (c.row !== row) console.log(`- ${(row = c.row)}`);
    const ratios = c.ratio === undefined ? '' : ` (x${c.ratio.toFixed(3)}, least x${/** @type {number} */ (c.leastRatio).toFixed(3)})`;
    console.log(`    ${c.key}: ${f(c.main)} → ${f(c.branch)}${ratios}${c.worse ? '  WORSE' : ''}`);
  }
}

if (AGAINST) {
  const theirs = join(AGAINST, 'tools/measure-progress/run.mjs');
  /** @type {ReturnType<typeof compare>} */
  const worse = [];
  for (const section of SECTIONS) {
    const first = pairs(theirs, section);
    const cold = UNGATED_TIMES.has(section) ? '; times are a cold process’s, reported and not judged' : '';
    printRound(`${section}: this branch against ${AGAINST} (${PAIRS} ABBA pairs; time as the median pair’s ratio, and the least runs’${cold})`, first);
    if (!first.some((c) => c.worse)) continue;
    // A number worse in one round of pairs is worse only if a second round agrees.
    const second = pairs(theirs, section);
    printRound(`${section}, again, for what the first round found worse`, second);
    worse.push(...worseTwice(first, second));
  }
  console.log(worse.length ? `\nWorse than main in both rounds:\n${worse.map((c) => `- ${c.row}: ${c.key}`).join('\n')}` : '\nNothing is worse than main.');
  process.exitCode = worse.length ? 1 : 0;
} else
  for (const section of SECTIONS)
    print(
      section === 'restart' ? 'Restart mid-turn: 1x, 10x and 100x agents in rooms of 4, half of each turn run' : section,
      Array.from({ length: RUNS }, () => once(OWN, section)),
    );
