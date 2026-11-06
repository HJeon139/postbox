#!/usr/bin/env node
// PF-1’s key-to-frame report (#508, designs/508/requirements.md, PF-1; designs/508/design.md, “Observability and
// calibration”): how long a key typed into the composer takes to reach the screen, in rooms the big-room seed
// generates at each size, in Chromium. The smallest size is 1×; PF-1 holds when every size’s p95 is within 10% of it.
// Run by hand, not a CI gate. Safari isn’t measured this sprint, and the report says so.
//
//   node tools/bench-key-frame.mjs --sizes 1000,4000,10000 --keys 200 --runs 3 --out designs/508/key-frame.md
//   node tools/bench-key-frame.mjs --app ../other-checkout …   (that checkout’s Postbox, this one’s instrument and seed)
//
// Each size gets a fresh Postbox on a free port and a temp data folder of its own, on mock agents, removed after,
// on Ctrl-C and SIGTERM too.
// Each run opens the room in a new document, clicks the composer, waits for the page to hold still, and types --warmup keys and then
// --keys keys, one every --interval ms (tools/key-frame-measure.mjs). The report (tools/key-frame-report.mjs) pools
// every run’s keys for each size.

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Store } from '../server/store.mjs';
import { launch } from './browser.mjs';
import { commitOf, conditionsOf, EVENT_THRESHOLD, machineOf, measureKeys } from './key-frame-measure.mjs';
import { formatReport, shownPath } from './key-frame-report.mjs';
import { summarize } from './key-frame-stats.mjs';
import { seedBigRoomData } from './uat/big-room.mjs';
import { startPostbox } from './uat/postbox.mjs';

/** The bench’s own checkout: its instrument and its seed. --app may name another checkout to measure. */
export const BENCH_ROOT = fileURLToPath(new URL('..', import.meta.url));
const THREAD = 'th_keyframe';
const AGENTS = ['researcher', 'critic', 'developer'];

/** A port nothing listens on, from the system. @returns {Promise<number>} */
const freePort = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
      s.close(() => ok(port));
    });
  });

/**
 * What a Ctrl-C or a SIGTERM must undo, as the bench goes: the page, and the size being measured, whose own finally
 * stops its Postbox and removes its data folder.
 * @type {{ page: any, size: Promise<any> | null, stopping: boolean }}
 */
const live = { page: null, size: null, stopping: false };

/**
 * Closes Chromium, so the size being measured fails at its next step and cleans up after itself, waits for that, and
 * exits as a shell reports the signal: 130 for SIGINT, 143 for SIGTERM. Removing the folder here instead raced the
 * size’s own steps, which went on writing into it.
 * @param {'SIGINT' | 'SIGTERM'} signal
 */
async function stopOn(signal) {
  if (live.stopping) return;
  live.stopping = true;
  const quietly = (p) => Promise.resolve(p).catch(() => null);
  await quietly(live.page?.close());
  await quietly(live.size);
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

/**
 * A whole number of at least one from an option, written in digits, or an error that names it. Number() alone took
 * “1e3” and “0x10”, and an empty value as 0.
 * @param {string} name  @param {string} raw
 */
function count(name, raw) {
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`--${name} takes a whole number of at least 1, not “${raw}”.`);
  return Number(raw);
}

/** The options, checked. @param {string[]} argv */
export function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      sizes: { type: 'string', default: '1000,4000,10000' },
      keys: { type: 'string', default: '200' },
      warmup: { type: 'string', default: '20' },
      runs: { type: 'string', default: '3' },
      interval: { type: 'string', default: '50' },
      out: { type: 'string', default: 'designs/508/key-frame-report.md' },
      app: { type: 'string' },
    },
  });
  const sizes = values.sizes.split(',').map((s) => count('sizes', s.trim()));
  return {
    sizes,
    keys: count('keys', values.keys),
    warmup: count('warmup', values.warmup),
    runs: count('runs', values.runs),
    intervalMs: count('interval', values.interval),
    out: resolve(values.out),
    app: appOption(values.app),
  };
}

/**
 * The checkout whose Postbox is measured, from --app, or null for the bench’s own. Measuring other commits through
 * one checkout keeps the instrument and the seeded rooms the same on every side of a comparison.
 * @param {string | undefined} raw
 */
function appOption(raw) {
  if (raw === undefined) return null;
  const app = resolve(raw);
  if (!existsSync(join(app, 'server', 'index.mjs'))) throw new Error(`--app takes a Postbox checkout, with server/index.mjs; ${raw} has none.`);
  return app;
}

/**
 * The report’s commit line: the measured Postbox’s commit, and the bench’s too when --app names another checkout.
 * @param {string} app  @param {string} bench  @param {(root: string) => string} [commit]
 */
export function commitLine(app, bench, commit = commitOf) {
  if (app === bench) return commit(bench);
  return `${commit(app)} (Postbox measured); ${commit(bench)} (the bench and its seed)`;
}

/**
 * The command as the report shows it, from the options as checked: every one spelled out, and --out as shownPath()
 * shows it, never an absolute path.
 * @param {ReturnType<typeof options>} o  @param {string} root
 */
export function commandLine(o, root) {
  const args = [`--sizes ${o.sizes.join(',')}`, `--keys ${o.keys}`, `--warmup ${o.warmup}`, `--runs ${o.runs}`, `--interval ${o.intervalMs}`];
  if (o.app) args.push(`--app ${shownPath(o.app, root)}`);
  return ['node tools/bench-key-frame.mjs', ...args, `--out ${shownPath(o.out, root)}`].join(' ');
}

/**
 * The report’s command and commit lines, for the checkout measured and the bench that measured it.
 * @param {ReturnType<typeof options>} o  @param {(root: string) => string} [commit]
 */
export function provenance(o, commit = commitOf) {
  return { command: commandLine(o, BENCH_ROOT), commit: commitLine(o.app ?? BENCH_ROOT, BENCH_ROOT, commit) };
}

/**
 * Opens url in a document of its own. Going to the same URL again changes only its hash, which keeps the document and
 * an earlier run’s listener and observer in it, so the page goes to about:blank first.
 * @param {{ goto: (url: string) => Promise<void> }} page  @param {string} url
 */
export async function openFresh(page, url) {
  await page.goto('about:blank');
  await page.goto(url);
}

/** The room as the page would have started it: a project, its three agents, and a room with their sessions. */
async function startRoom(data) {
  const store = await new Store(data).load();
  store.emit('project', { id: 'pr_keyframe', name: 'Key to frame', folder: data });
  const members = AGENTS.map((handle) => `se_${handle}`);
  for (const handle of AGENTS) store.emit('persona', { id: `pe_${handle}`, handle, backend: 'mock', model: 'mock' });
  store.emit('thread', { id: THREAD, projectId: 'pr_keyframe', kind: 'room', title: 'The release, in a long room', members });
  for (const handle of AGENTS) store.emit('session', { id: `se_${handle}`, threadId: THREAD, handle, personaId: `pe_${handle}` });
  await store.close();
}

/**
 * One size: a fresh Postbox with the room seeded at that count, measured runs times. Its data folder is removed
 * however it ends, a Postbox that didn’t start included. start, port and tmp are for tests.
 */
export async function measureSize(page, items, o, log, { start = startPostbox, port = freePort, tmp = tmpdir() } = {}) {
  const data = await mkdtemp(join(tmp, `pb-key-frame-${items}-`));
  const pooled = { eventTiming: [], nextFrame: [], below: 0 };
  let postbox = null;
  try {
    postbox = await start({ root: o.app ?? BENCH_ROOT, port: await port(), data, env: { POSTBOX_BACKENDS: 'mock' }, log: () => {} });
    await postbox.restart({
      whileDown: async () => {
        await startRoom(data);
        await seedBigRoomData(data, THREAD, AGENTS, { count: items });
      },
    });
    for (let run = 1; run <= o.runs; run++) {
      await openFresh(page, `${postbox.origin}/#/t/${THREAD}`);
      const r = await measureKeys(page, { keys: o.keys, warmup: o.warmup, intervalMs: o.intervalMs });
      pooled.eventTiming.push(...r.eventTiming);
      pooled.nextFrame.push(...r.nextFrame);
      pooled.below += r.below;
      log(`${items.toLocaleString('en-US')} items, run ${run} of ${o.runs}: ${r.eventTiming.length} keys.`);
    }
  } finally {
    await postbox?.kill();
    await rm(data, { recursive: true, force: true });
  }
  return { items, eventTiming: summarize(pooled.eventTiming), nextFrame: summarize(pooled.nextFrame), below: pooled.below };
}

async function main() {
  const o = options(process.argv.slice(2));
  const log = (line) => console.log(line);
  // Detached, so the bench owns Ctrl-C and SIGTERM, and Chromium stays up until stopOn() has used and closed it.
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.once(signal, () => void stopOn(signal));
  const page = await launch({ detached: true });
  live.page = page;
  try {
    await page.size(1280, 900, { theme: 'dark' });
    const loadAtStart = loadavg()[0];
    const results = [];
    for (const items of o.sizes) {
      if (live.stopping) return;
      live.size = measureSize(page, items, o, log);
      results.push(await live.size);
    }
    if (page.logs.length) log(`The page logged ${page.logs.length} errors; the first: ${page.logs[0]}`);
    const report = formatReport({
      ...provenance(o),
      date: new Date().toISOString(),
      machine: await machineOf(page),
      conditions: await conditionsOf(page, loadAtStart),
      inputs: { sizes: o.sizes, keys: o.keys, warmup: o.warmup, runs: o.runs, intervalMs: o.intervalMs },
      results,
      threshold: EVENT_THRESHOLD,
    });
    await writeFile(o.out, report);
    log(`Wrote ${shownPath(o.out, BENCH_ROOT)}.`);
  } finally {
    await page.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    // Stopped by a signal: what failed is what stopOn() closed under it, and it exits with the signal’s code.
    if (live.stopping) return;
    console.error(e.message);
    process.exit(1);
  });
