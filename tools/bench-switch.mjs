#!/usr/bin/env node
// How long Postbox takes to switch into a long conversation (#508): from a short conversation, open the long room the
// big-room seed generates at each size, by a click, as a person does, in Chromium, and time it two ways:
// - Last item drawn: the click’s pointerdown to the frame after the one that drew the room’s last seeded item (by its
//   data-key) inside the transcript’s visible box (rAF → rAF).
// - Key’s next frame: the same pointerdown to the frame after a key typed into the long room’s composer as soon as its
//   view is on the page (keydown → rAF → rAF). The key is typed then, not with the click, since one handled before the
//   switch’s render would land in the short conversation’s composer.
// Two switches, each timed --runs times in a fresh document opened on the short conversation and held still first:
// - Project switch: from a conversation in another project, the places menu under the Postbox mark (shell.mjs,
//   topbar()), then the long room’s project. The rail lists only the open project’s conversations, and another
//   project only while it needs you, so the places menu is where a click reaches another project. The menu is opened
//   before the timer starts; the project opens on its latest conversation, the long room (last-place.mjs, latestIn()),
//   so no second click is needed.
// - Conversation switch: from a short room in the long room’s project, the long room’s row in the rail.
// Every run proves it timed the long room with every seeded item drawn (proveRun()), and fails loudly if not.
// Run by hand, not a CI gate.
//
//   node tools/bench-switch.mjs --sizes 1000,4000,10000 --runs 5 --out designs/508/switch-report.md
//   node tools/bench-switch.mjs --app ../other-checkout …   (that checkout’s Postbox, this one’s instrument and seed)
//   node tools/bench-switch.mjs --sizes 10000 --runs 1 --trace switch.json   (and one traced conversation switch)
//
// Each size gets a fresh Postbox on a free port and a temp data folder of its own, on mock agents, removed after,
// on Ctrl-C and SIGTERM too.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Store } from '../server/store.mjs';
import { appOption, BENCH_ROOT, commitLine, count, freePort } from './bench-key-frame.mjs';
import { launch } from './browser.mjs';
import { commitOf, conditionsOf, machineOf } from './key-frame-measure.mjs';
import { shownPath } from './key-frame-report.mjs';
import { summarize } from './key-frame-stats.mjs';
import { IDS, LONG_PROJECT, LONG_PROJECT_2, NEEDS_SWITCH, SHORT_ITEMS, SWITCHES, timeSwitch, traceSwitch } from './switch-measure.mjs';
import { formatReport } from './switch-report.mjs';
import { seedBigRoomData } from './uat/big-room.mjs';
import { startPostbox } from './uat/postbox.mjs';
import { realIdOf, seedRealRoomData } from './uat/real-room.mjs';

export { BENCH_ROOT, formatReport, IDS, NEEDS_SWITCH, proveCounts, proveRun, SWITCHES };

import { proveCounts, proveRun } from './switch-measure.mjs';

const AGENTS = ['researcher', 'critic', 'developer'];
/** What a Ctrl-C or a SIGTERM must undo, as in tools/bench-key-frame.mjs. */
const live = { page: null, size: null, stopping: false };

async function stopOn(signal) {
  if (live.stopping) return;
  live.stopping = true;
  const quietly = (p) => Promise.resolve(p).catch(() => null);
  await quietly(live.page?.close());
  await quietly(live.size);
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

/** The options, checked. @param {string[]} argv */
export function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      sizes: { type: 'string', default: '1000,4000,10000' },
      runs: { type: 'string', default: '5' },
      out: { type: 'string', default: 'designs/508/switch-report.md' },
      app: { type: 'string' },
      trace: { type: 'string' },
      seed: { type: 'string', default: 'uniform' },
      needs: { type: 'boolean', default: false },
    },
  });
  return {
    sizes: values.sizes.split(',').map((s) => count('sizes', s.trim())),
    runs: count('runs', values.runs),
    out: resolve(values.out),
    app: appOption(values.app),
    trace: values.trace === undefined ? null : resolve(values.trace),
    seed: seedOption(values.seed),
    needs: values.needs,
  };
}

/** The long room’s seed: the uniform big-room seed, or the real-shape one (#305’s measured room). @param {string} raw */
function seedOption(raw) {
  if (raw !== 'uniform' && raw !== 'real') throw new Error(`--seed takes uniform or real, not “${raw}”.`);
  return raw;
}

/** The command as the report shows it, every option spelled out, no absolute path. @param {ReturnType<typeof options>} o  @param {string} root */
export function commandLine(o, root) {
  const args = [`--sizes ${o.sizes.join(',')}`, `--runs ${o.runs}`];
  if (o.app) args.push(`--app ${shownPath(o.app, root)}`);
  if (o.trace) args.push(`--trace ${shownPath(o.trace, root)}`);
  if (o.seed === 'real') args.push('--seed real');
  if (o.needs) args.push('--needs');
  return ['node tools/bench-switch.mjs', ...args, `--out ${shownPath(o.out, root)}`].join(' ');
}

/** The report’s command and commit lines. @param {ReturnType<typeof options>} o  @param {(root: string) => string} [commit] */
export function provenance(o, commit = commitOf) {
  return { command: commandLine(o, BENCH_ROOT), commit: commitLine(o.app ?? BENCH_ROOT, BENCH_ROOT, commit) };
}

/**
 * A short conversation’s items, oldest first, from at: the person and its agents in turn, ids of its own.
 * @param {string} threadId  @param {string[]} handles  @param {number} at
 */
export function shortItems(threadId, handles, at) {
  const tag = threadId.replace(/^th_sw_/, '').replace(/_/g, '');
  return Array.from({ length: SHORT_ITEMS }, (_, i) => {
    const id = `it_sw_${tag}_${String(i).padStart(2, '0')}`;
    const when = at + i * 60_000;
    return i % 2 === 0
      ? { id, at: when, kind: 'user', text: `Short note ${i}: the changelog is in order.` }
      : { id, at: when, kind: 'agent', handle: handles[i % handles.length], text: `Reply ${i}: checked, nothing needs anyone yet.` };
  });
}

/**
 * Seeds both projects while Postbox is down: a short room in one, and in the other a short room and the long one,
 * which the big-room seed fills. The short rooms’ items are older than the long room’s, so its project opens on it.
 * @param {string} data  @param {number} items
 */
/** The switches a run times: the two by click, and with --needs the ⌃J one too. @param {{ needs: boolean }} o */
export const switchesFor = (o) => (o.needs ? [...SWITCHES, NEEDS_SWITCH] : SWITCHES);

/** The open ask at the end of a long room, by --needs. @param {string} threadId */
export const askId = (threadId) => `it_ask_${threadId}`;

/**
 * A long room’s open ask, from handle’s session, posted at, and the need it gives that session: the item ⌃J goes to.
 * @param {string} threadId  @param {string} handle  @param {number} at
 */
export function openAsk(threadId, handle, at) {
  const id = askId(threadId);
  const block = {
    id: `ask-${threadId}`,
    type: 'confirm',
    version: 1,
    fallback: 'Confirm the release?',
    statement: 'Confirm the release?',
    confirmLabel: 'Release',
  };
  return {
    item: { id, at, kind: 'block', handle, valid: true, block },
    need: { kind: 'block', itemId: id, threadId, text: `@${handle} asks you to confirm the release` },
  };
}

/**
 * What a run that lands on each long room must find there: its thread, how many items, and its last. With --needs,
 * each long room ends on its open ask.
 * @param {{ items: number, seed: string, needs: boolean }} o
 */
export function expectedRooms({ items, seed, needs }) {
  const room = (thread) => (needs ? { thread, count: items + 1, last: askId(thread) } : { thread, count: items, last: lastIdOf(seed, items) });
  return needs ? { [IDS.long]: room(IDS.long), [IDS.long2]: room(IDS.long2) } : { [IDS.long]: room(IDS.long) };
}

/** Seeds one long room at its size, by --seed. */
async function seedLong(data, threadId, items, seed) {
  if (seed === 'real') await seedRealRoomData(data, threadId, AGENTS, { count: items });
  else await seedBigRoomData(data, threadId, AGENTS, { count: items });
}

/**
 * Gives each long room an open ask at its end, from its first agent, and that agent’s session the need. The second
 * room’s ask is the older, so ⌃J from the first room’s goes there next.
 */
async function seedAsks(data, rooms) {
  const store = await new Store(data).load();
  rooms.forEach((threadId, k) => {
    const se = Object.values(store.state.sessions).find((x) => x.threadId === threadId && x.handle === AGENTS[0]);
    const at = Date.now() - (rooms.length - k) * 60_000;
    const { item, need } = openAsk(threadId, AGENTS[0], at - (k === 1 ? 3_600_000 : 0));
    store.emit('item.add', { threadId, item: { ...item, sessionId: se.id, personaId: se.personaId } });
    store.emit('session', { ...se, needs: need, state: 'waiting' });
  });
  await store.close();
}

export async function seedRooms(data, items, seed, needs) {
  for (const sub of ['a', 'b', 'c']) await mkdir(join(data, sub), { recursive: true });
  const store = await new Store(data).load();
  store.emit('project', { id: IDS.projectA, name: 'Short project', folder: join(data, 'a') });
  store.emit('project', { id: IDS.projectB, name: LONG_PROJECT, folder: join(data, 'b') });
  if (needs) store.emit('project', { id: IDS.projectC, name: LONG_PROJECT_2, folder: join(data, 'c') });
  for (const handle of AGENTS) store.emit('persona', { id: `pe_${handle}`, handle, backend: 'mock', model: 'mock' });
  const rooms = [
    [IDS.shortA, IDS.projectA, 'A short room'],
    [IDS.shortB, IDS.projectB, 'Another short room'],
    [IDS.long, IDS.projectB, 'The release, in a long room'],
    ...(needs ? [[IDS.long2, IDS.projectC, 'The next release, in another long room']] : []),
  ];
  for (const [id, projectId, title] of rooms) {
    const members = AGENTS.map((handle) => `se_${id}_${handle}`);
    store.emit('thread', { id, projectId, kind: 'room', title, members });
    for (const handle of AGENTS) store.emit('session', { id: `se_${id}_${handle}`, threadId: id, handle, personaId: `pe_${handle}` });
  }
  for (const id of [IDS.shortA, IDS.shortB])
    for (const item of shortItems(id, AGENTS, Date.UTC(2026, 7, 1, 9)))
      store.emit('item.add', { threadId: id, item: item.handle ? { ...item, sessionId: `se_${id}_${item.handle}`, personaId: `pe_${item.handle}` } : item });
  await store.close();
  await seedLong(data, IDS.long, items, seed);
  if (needs) {
    await seedLong(data, IDS.long2, items, seed);
    await seedAsks(data, [IDS.long, IDS.long2]);
  }
  return expectedRooms({ items, seed, needs });
}

/** The middle of a list of counts (the lower middle of an even one). @param {number[]} xs */
export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

/** The big-room seed’s last item’s id at a size, as tools/uat/big-room.mjs pads it. @param {number} items */
export const lastIdOf = (seed, items) =>
  seed === 'real' ? realIdOf(items - 1, items) : `it_big${String(items - 1).padStart(Math.max(4, String(items - 1).length), '0')}`;

/**
 * One size: a fresh Postbox with the rooms seeded, each switch timed runs times. Its data folder is removed however
 * it ends. start, port and tmp are for tests; trace, a file to record one more conversation switch’s trace into.
 */
export async function measureSize(page, items, o, log, { start = startPostbox, port = freePort, tmp = tmpdir(), trace = null } = {}) {
  const data = await mkdtemp(join(tmp, `pb-switch-${items}-`));
  const switches = switchesFor(o);
  const times = Object.fromEntries(switches.map((s) => [s.name, { drawn: [], key: [], page: [], transcript: [] }]));
  let postbox = null;
  try {
    postbox = await start({ root: o.app ?? BENCH_ROOT, port: await port(), data, env: { POSTBOX_BACKENDS: 'mock' }, log: () => {} });
    /** @type {any} */
    let expected = null;
    await postbox.restart({
      whileDown: async () => {
        expected = await seedRooms(data, items, o.seed, o.needs);
      },
    });
    for (let run = 1; run <= o.runs; run++)
      for (const sw of switches) {
        const t = await timeSwitch(page, postbox.origin, sw, expected[sw.to]);
        times[sw.name].drawn.push(t.drawn);
        times[sw.name].key.push(t.key);
        times[sw.name].page.push(t.elements.page);
        times[sw.name].transcript.push(t.elements.transcript);
        log(
          `${items.toLocaleString('en-US')} items, run ${run} of ${o.runs}, ${sw.name} switch: last item drawn ${t.drawn.toFixed(1)} ms, key’s frame ${t.key.toFixed(1)} ms.`,
        );
      }
    if (trace) await traceSwitch(page, postbox.origin, expected[IDS.long], trace, log);
  } finally {
    await postbox?.kill();
    await rm(data, { recursive: true, force: true });
  }
  const out = { items };
  for (const s of switches) {
    const t = times[s.name];
    out[s.name] = { drawn: summarize(t.drawn), key: summarize(t.key), elements: { page: median(t.page), transcript: median(t.transcript) } };
  }
  return out;
}

async function main() {
  const o = options(process.argv.slice(2));
  const log = (line) => console.log(line);
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.once(signal, () => void stopOn(signal));
  const page = await launch({ detached: true });
  live.page = page;
  try {
    await page.size(1280, 900, { theme: 'dark' });
    const loadAtStart = loadavg()[0];
    const results = [];
    for (const [i, items] of o.sizes.entries()) {
      if (live.stopping) return;
      live.size = measureSize(page, items, o, log, { trace: i === o.sizes.length - 1 ? o.trace : null });
      results.push(await live.size);
    }
    if (page.logs.length) log(`The page logged ${page.logs.length} errors; the first: ${page.logs[0]}`);
    const report = formatReport({
      ...provenance(o),
      date: new Date().toISOString(),
      machine: await machineOf(page),
      conditions: await conditionsOf(page, loadAtStart),
      inputs: { sizes: o.sizes, runs: o.runs, seed: o.seed },
      results,
    });
    await writeFile(o.out, report);
    log(`Wrote ${shownPath(o.out, BENCH_ROOT)}.`);
  } finally {
    await page.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    if (live.stopping) return;
    console.error(e.message);
    process.exit(1);
  });
