// How much of the event log a running turn’s progress is (designs/architecture/live-progress.md, “Why”): replays each
// recorded Claude Code stream in tests/fixtures/claude-code/ through the real stream mapper into a runtime, and sums
// the bytes of each event as the log writes it, by kind. It changes nothing; the live-only progress work records
// main’s numbers with it before any change, and each pull request compares against them.
//
//   node tools/measure-progress.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { settle, setup } from '../tests/side-threads-fixture.mjs';

const DIR = new URL('../tests/fixtures/claude-code/', import.meta.url);
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

/** @param {string} name */
const lines = (name) =>
  readFileSync(new URL(name, DIR), 'utf8')
    .trim()
    .split('\n')
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });

/** @type {Record<string, { bytes: number, events: number }>} */
const totals = {};
let turns = 0;
let finalText = 0;
let records = 0;
for (const name of readdirSync(DIR).filter((n) => n.endsWith('.jsonl'))) {
  const { rt, store, t, adapter } = setup();
  /** @type {any[]} */
  const seen = [];
  store.subscribe((/** @type {any} */ ev) => seen.push(ev));
  adapter.next.push(async (/** @type {any} */ c) => {
    const m = createStreamMapper(c, { now: () => Date.now() });
    for (const l of lines(name)) {
      try {
        m.push(l);
      } catch {}
    }
  });
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  turns++;
  for (const ev of seen) {
    const k = kindOf(ev);
    const row = (totals[k] ??= { bytes: 0, events: 0 });
    row.bytes += JSON.stringify(ev).length + 1;
    row.events++;
  }
  for (const it of store.items(t.id)) {
    if (it.activity?.steps?.length) records += JSON.stringify(it.activity).length;
    if (it.kind === 'agent') finalText += String(it.text ?? '').length;
  }
}
const sum = (/** @type {(k: string) => boolean} */ f) =>
  Object.entries(totals)
    .filter(([k]) => f(k))
    .reduce((a, [, v]) => ({ bytes: a.bytes + v.bytes, events: a.events + v.events }), { bytes: 0, events: 0 });
const all = sum(() => true);
const progress = sum((k) => k.startsWith('progress'));
console.log(`${turns} turns: ${all.bytes} bytes in ${all.events} events`);
console.log(`progress: ${progress.bytes} bytes (${((100 * progress.bytes) / all.bytes).toFixed(1)}%) in ${progress.events} events`);
console.log(`replies’ final text: ${finalText} characters; folded records: ${records} bytes`);
for (const [k, v] of Object.entries(totals).sort((a, b) => b[1].bytes - a[1].bytes)) console.log(`  ${k}: ${v.bytes} bytes, ${v.events} events`);
process.exit(0);
