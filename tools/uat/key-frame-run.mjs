// `--measure-key-frame <report.md>` in a run (tools/uat-run.mjs; #508, PF-1): once the big room is seeded and open,
// the runner measures its key-to-frame times on the run’s own page, as tools/bench-key-frame.mjs does at one size,
// writes the report there, and records it in facts.probes.keyFrame for the key-frame-measured trigger
// (tools/uat/triggers-measure.mjs). A smoke check that the tool runs on a run’s room, not PF-1’s measurement: that is
// the bench’s, at 1×, 4× and 10×. tools/uat-run.mjs declares the option.

import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearDraft, commitOf, EVENT_THRESHOLD, machineOf, measureKeys } from '../key-frame-measure.mjs';
import { formatReport } from '../key-frame-report.mjs';
import { summarize } from '../key-frame-stats.mjs';
import { openBigRoom } from './big-room.mjs';

const INPUTS = { keys: 40, warmup: 10, runs: 1, intervalMs: 50 };
/** The big room’s size, as tools/uat/big-room.mjs seeds it by default: 1×. */
const ITEMS = 1000;

/**
 * `- seed: big-room`: seeds and opens the run’s room (tools/uat/big-room.mjs), and with --measure-key-frame measures
 * it there. Returns the room’s note for the tester’s summary.
 * @param {Parameters<typeof openBigRoom>[0] & { opt: Record<string, any>, facts: { probes: { keyFrame: any[] } } }} o
 */
export async function openRunRoom({ opt, facts, ...room }) {
  const note = await openBigRoom({ ...room, count: ITEMS });
  const out = opt['measure-key-frame'];
  if (out) {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    await measureRunRoom({ page: room.page, root, threadId: room.threadId, items: ITEMS, out, probes: facts.probes, log: room.log });
  }
  return note;
}

/**
 * Measures the open room and writes the report to out, then records the measurement. One that fails is recorded
 * with no report, so the trigger stays silent, and the run goes on: the tester still has the room to test.
 * @param {{ page: import('../key-frame-measure.mjs').Page, root: string, threadId: string, items: number, out: string,
 *   probes: { keyFrame: any[] }, log: (line: string) => void }} o
 */
export async function measureRunRoom({ page, root, threadId, items, out, probes, log }) {
  const shown = out.replaceAll(homedir(), '~');
  try {
    const r = await measureKeys(page, INPUTS);
    // The tester arrives at an empty composer, not at the keys the measurement typed.
    await page.evaluate(`(${clearDraft})()`);
    const report = formatReport({
      command: `node tools/uat-run.mjs --measure-key-frame ${shown}`,
      commit: commitOf(root),
      date: new Date().toISOString(),
      machine: await machineOf(page),
      inputs: { sizes: [items], ...INPUTS },
      results: [{ items, eventTiming: summarize(r.eventTiming), nextFrame: summarize(r.nextFrame), below: r.below }],
      threshold: EVENT_THRESHOLD,
    });
    await writeFile(resolve(out), report);
    probes.keyFrame.push({ threadId, items, keys: r.eventTiming.length, report: shown, at: Date.now() });
    log(`Measured ${r.eventTiming.length} keys in the big room; wrote ${shown}.`);
  } catch (e) {
    probes.keyFrame.push({ threadId, items, keys: 0, report: null, at: Date.now(), error: String(e?.message ?? e) });
    log(`Couldn’t measure the big room’s key-to-frame times: ${e?.message ?? e}`);
  }
}
