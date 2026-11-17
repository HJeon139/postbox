// How much of the event log a running turn’s progress is, and what it costs (designs/architecture/live-progress.md,
// “Why” and “Proving it costs nothing new”). It changes nothing: the live-only progress work records main’s numbers
// with it before any change, and each pull request compares against them, back to back on the same machine.
//
//   node tools/measure-progress.mjs            every section
//   node tools/measure-progress.mjs backends   one of: backends, long, crowded, restart
//
// - backends: each recorded stream in tests/fixtures/<backend>/ replayed through its adapter’s real stream mapper into
//   a runtime, with each event’s bytes summed as the log writes it, by kind;
// - long: one turn of 300 and of 1,000 steps, words between them: its log bytes, step records and time;
// - crowded: 8 and 40 agents in one room, each streaming the largest recorded turn at once;
// - restart: a log written to disk by the 40 agents, then opened again: its size, the time to load it, the heap after.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgyMapper } from '../server/adapters/antigravity-cli.mjs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { createCodexMapper } from '../server/adapters/codex.mjs';
import { createKiroMapper } from '../server/adapters/kiro-cli.mjs';
import { stopTimers } from '../server/runtime-close.mjs';
import { Store } from '../server/store.mjs';
import { settle, setup } from '../tests/side-threads-fixture.mjs';

const FIXTURES = new URL('../tests/fixtures/', import.meta.url);
/** Each backend’s recorded streams, and its adapter’s mapper. */
const BACKENDS = {
  'claude-code': (/** @type {any} */ c) => createStreamMapper(c, { now: () => Date.now() }),
  'codex-app-server': (/** @type {any} */ c) => createCodexMapper(c),
  'kiro-cli': (/** @type {any} */ c) => createKiroMapper(c, { now: () => Date.now() }),
  'antigravity-cli': (/** @type {any} */ c) => createAgyMapper(c, { now: () => Date.now() }),
};
/** A session patch is progress when it changes only these, which go live: `state` stays stored. */
const PROGRESS = new Set(['toolCalls', 'toolCount', 'currentStep', 'glimpse', 'subagents', 'compacting']);

/** @param {{ type: string, data?: any }} ev */
function kindOf(ev) {
  const d = ev.data ?? {};
  if (ev.type === 'item.text') return 'progress: item.text';
  if (ev.type === 'item.patch' && d.activityStep) return 'progress: item.patch activityStep';
  if (ev.type === 'item.patch' && d.foldSteps) return 'end: foldSteps';
  if (ev.type === 'session.patch' && !(d.unset ?? []).length && Object.keys(d.patch ?? {}).every((k) => PROGRESS.has(k))) return 'progress: session.patch';
  return `other: ${ev.type}`;
}

/** A recorded stream’s events, skipping a line that isn’t JSON. @param {string} backend @param {string} name */
const lines = (backend, name) =>
  readFileSync(new URL(`${backend}/${name}`, FIXTURES), 'utf8')
    .trim()
    .split('\n')
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });

/** Feeds a recorded stream to its mapper; a failure the stream records is part of it. @param {any} m @param {any[]} events */
function feed(m, events) {
  for (const e of events) {
    try {
      m.push(e);
    } catch {}
  }
}

/** Every event the store applies from now on. @param {any} store */
function listen(store) {
  /** @type {any[]} */
  const seen = [];
  store.subscribe((/** @type {any} */ ev) => seen.push(ev));
  return seen;
}

/** Sums events by kind. @param {any[]} events */
function tally(events) {
  /** @type {Record<string, { bytes: number, events: number }>} */
  const t = {};
  for (const ev of events) {
    const row = (t[kindOf(ev)] ??= { bytes: 0, events: 0 });
    row.bytes += JSON.stringify(ev).length + 1;
    row.events++;
  }
  return t;
}

/** The share of a tally that is progress. @param {Record<string, { bytes: number, events: number }>} t */
function share(t) {
  let all = 0;
  let progress = 0;
  let events = 0;
  for (const [k, v] of Object.entries(t)) {
    all += v.bytes;
    if (k.startsWith('progress')) {
      progress += v.bytes;
      events += v.events;
    }
  }
  return { all, progress, events, pct: all ? ((100 * progress) / all).toFixed(1) : '0' };
}

async function backends() {
  console.log('## Backends: each recorded turn replayed through its mapper');
  for (const [backend, mapper] of Object.entries(BACKENDS)) {
    const names = readdirSync(new URL(`${backend}/`, FIXTURES)).filter((n) => n.endsWith('.jsonl'));
    /** @type {any[]} */
    const all = [];
    let text = 0;
    for (const name of names) {
      const { rt, store, t, adapter } = setup();
      const seen = listen(store);
      adapter.next.push(async (/** @type {any} */ c) => feed(mapper(c), lines(backend, name)));
      rt.sendMessage(t.id, { text: '@beta go' });
      await settle(rt);
      all.push(...seen);
      for (const it of store.items(t.id)) if (it.kind === 'agent') text += String(it.text ?? '').length;
      stopTimers(rt);
    }
    const s = share(tally(all));
    console.log(
      `${backend}: ${names.length} turns, ${s.all} bytes; progress ${s.progress} bytes (${s.pct}%) in ${s.events} events; replies’ text ${text} characters`,
    );
  }
}

async function long() {
  console.log('## A long turn: steps with words between them');
  for (const n of [300, 1000]) {
    const { rt, store, t, adapter } = setup();
    const seen = listen(store);
    adapter.next.push(async (/** @type {any} */ c) => {
      for (let i = 0; i < n; i++) {
        c.text(`Step ${i} reads the next file and notes what it found. `);
        c.activity({ id: `s${i}`, label: `Read file ${i}`, state: 'running' });
        c.activity({ id: `s${i}`, label: `Read file ${i}`, state: 'done', ms: 5 });
      }
      c.text('Done.');
    });
    const at = performance.now();
    rt.sendMessage(t.id, { text: '@beta go' });
    await settle(rt);
    const ms = performance.now() - at;
    const tl = tally(seen);
    const s = share(tl);
    const steps = tl['progress: item.patch activityStep']?.events ?? 0;
    console.log(`${n} steps: ${s.all} bytes; progress ${s.progress} bytes (${s.pct}%); ${steps} step records; ${ms.toFixed(0)} ms`);
    stopTimers(rt);
  }
}

/** The largest recorded Claude Code turn, which each crowded agent streams. */
const LARGEST = readdirSync(new URL('claude-code/', FIXTURES))
  .filter((n) => n.endsWith('.jsonl'))
  .map((n) => ({ n, size: statSync(new URL(`claude-code/${n}`, FIXTURES)).size }))
  .sort((a, b) => b.size - a.size)[0].n;

/** n agents in one room, each streaming the largest recorded turn at once. @param {number} n @param {any} [store] */
async function room(n, store) {
  const f = setup(store);
  const seen = listen(f.store);
  const handles = [];
  for (let i = 0; i < n; i++) {
    const p = f.rt.createPersona({ handle: `a${i}` });
    f.rt.ensureSession(f.t.id, p.id);
    handles.push(`@a${i}`);
  }
  const events = lines('claude-code', LARGEST);
  for (let i = 0; i < n; i++) f.adapter.next.push(async (/** @type {any} */ c) => feed(BACKENDS['claude-code'](c), events));
  const at = performance.now();
  f.rt.sendMessage(f.t.id, { text: `${handles.join(' ')} go` });
  await settle(f.rt);
  for (let i = 0; i < 400 && f.rt.turns.size; i++) await new Promise((r) => setTimeout(r, 25));
  return { ...f, seen, ms: performance.now() - at };
}

async function crowded() {
  console.log(`## A crowded room: agents streaming ${LARGEST} at once`);
  for (const n of [8, 40]) {
    const { rt, seen, ms } = await room(n);
    const s = share(tally(seen));
    console.log(`${n} agents: ${s.all} bytes; progress ${s.progress} bytes (${s.pct}%) in ${s.events} events; ${ms.toFixed(0)} ms`);
    stopTimers(rt);
  }
}

async function restart() {
  console.log('## Restart: the 40 agents’ log, opened again');
  const dir = mkdtempSync(join(tmpdir(), 'pb-measure-'));
  try {
    const store = await new Store(dir).load();
    const { rt } = await room(40, store);
    stopTimers(rt);
    // What a turn’s end writes after it leaves the running turns, before the store closes.
    await new Promise((r) => setTimeout(r, 200));
    stopTimers(rt);
    await store.close();
    const files = readdirSync(dir).map((n) => ({ n, size: statSync(join(dir, n)).size }));
    const log = files.filter((x) => /log|jsonl/.test(x.n)).reduce((a, x) => a + x.size, 0);
    const snap = files.filter((x) => /snap/.test(x.n)).reduce((a, x) => a + x.size, 0);
    globalThis.gc?.();
    const heap = process.memoryUsage().heapUsed;
    const at = performance.now();
    const again = await new Store(dir).load();
    const ms = performance.now() - at;
    globalThis.gc?.();
    const grew = process.memoryUsage().heapUsed - heap;
    console.log(`log ${log} bytes, snapshot ${snap} bytes; load ${ms.toFixed(0)} ms; heap after load +${(grew / 1e6).toFixed(1)} MB`);
    await again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SECTIONS = { backends, long, crowded, restart };
const asked = process.argv[2];
for (const [name, run] of Object.entries(SECTIONS)) if (!asked || asked === name) await run();
process.exit(0);
