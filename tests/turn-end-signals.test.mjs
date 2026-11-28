// The end of a turn as Bus signals (designs/architecture/services.md, “The end of a turn”): Turns raises
// `turn.ending`, `turn.settled`, `turn.replied`, then `turn.failed` or `turn.ended`, and stopping a turn raises
// `turn.stopping` and `turn.exited`. Each concern’s step is its listener, so Turns’ end knows only the signals.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { held, settle, setup } from './side-threads-fixture.mjs';

const SIGNALS = ['turn.ending', 'turn.settled', 'turn.replied', 'turn.failed', 'turn.ended', 'turn.stopping', 'turn.exited'];

/** Records each turn signal as it’s raised, with whether the turn still counted as running then. @param {any} rt */
function record(rt) {
  /** @type {{ signal: string, running: boolean }[]} */
  const heard = [];
  for (const signal of SIGNALS) rt.bus.on(signal, ({ turn }) => heard.push({ signal, running: rt.turns.get(turn.sessionId) === turn }));
  return heard;
}

test('#1429 a turn that ends well raises turn.ending while it still runs, then turn.settled, turn.replied and turn.ended', async () => {
  const { rt, t } = setup();
  const heard = record(rt);
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  assert.deepEqual(heard, [
    { signal: 'turn.ending', running: true },
    { signal: 'turn.settled', running: false },
    { signal: 'turn.replied', running: false },
    { signal: 'turn.ended', running: false },
  ]);
});

test('#1429 a turn that fails raises turn.ending, turn.settled and turn.replied, then turn.failed', async () => {
  const { rt, t, adapter } = setup();
  const heard = record(rt);
  adapter.next.push(async () => {
    throw new Error('The model refused.');
  });
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  assert.deepEqual(
    heard.map((h) => h.signal),
    ['turn.ending', 'turn.settled', 'turn.replied', 'turn.failed'],
  );
});

test('#1429 a turn the person stops raises turn.stopping, then turn.exited once its process has exited', async () => {
  const { rt, t, adapter, beta } = setup();
  const heard = record(rt);
  const h = held();
  adapter.next.push(h.step);
  rt.sendMessage(t.id, { text: '@beta go' });
  for (let i = 0; i < 100 && !rt.turns.get(beta.id); i++) await new Promise((r) => setTimeout(r, 5));
  rt.stop(beta.id, { by: 'you' });
  assert.deepEqual(
    heard.map((x) => x.signal),
    ['turn.stopping'],
  );
  h.release();
  await settle(rt);
  assert.deepEqual(
    heard.map((x) => x.signal),
    ['turn.stopping', 'turn.exited'],
  );
});

test('#1429 the end of a turn leaves each concern’s step to its listener', () => {
  const src = readFileSync(new URL('../server/turn-finish.mjs', import.meta.url), 'utf8');
  const direct = [
    ...src.matchAll(
      /\b(settleScheduledWake|postSummary|fixEnded|expirePermissions|rt\.work\.endWork|rt\.checks\.\w+|rt\.summaries\.\w+|rt\.clearSummaryPending|rt\.delivery\.(?!takenBy\b)\w+)\b/g,
    ),
  ].map((m) => m[1]);
  assert.deepEqual([...new Set(direct)], []);
});
