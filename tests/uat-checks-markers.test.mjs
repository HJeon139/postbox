// marker-before-output (#508, server/room-checks-delivery.mjs): a session’s catch-up marker moved for a turn that then
// produced no output (DL-3). The rooms are hand-built from the shapes UAT runs record (tests/delivery-fixture.mjs says
// why, and which). Moved from tests/uat-checks-delivery.test.mjs for size.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChecks } from '../tools/uat/checks.mjs';
import { room, stopAgent, T0 } from './delivery-fixture.mjs';

const s = (n) => T0 + n * 1000;
const found = (f, id) => runChecks(f, { only: [id] });

/**
 * @researcher’s marker moves as its turn’s prompt is built; the turn then writes something, or nothing. recorded: whether
 * Claude Code wrote the prompt to its transcript before the turn ended; stopped: the person pressed Stop (or Send now)
 * before its first token.
 */
function markerRoom({ output, recorded = false, stopped = false }) {
  const r = room();
  r.agent('researcher');
  r.add({ id: 'it_a', at: s(1), kind: 'user', text: 'First message' });
  r.marker('researcher', null, s(0));
  r.marker('researcher', 'it_a', s(10));
  r.turn('researcher', s(10) + 3, { prompt: 'First message', output, recorded, ms: 4000 });
  if (stopped) stopAgent(r, 'researcher', s(10) + 3000);
  return r.f;
}

test('marker-before-output fires when the marker moved for a turn that wrote nothing and recorded nothing', () => {
  // Cut after its init, as tools/uat/fault-launcher.mjs cuts a turn: no recorded failing turn exists yet, and Claude
  // Code never wrote the prompt.
  const out = found(markerRoom({ output: false }), 'marker-before-output');
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /from the start to it_a/);
  assert.deepEqual(out[0].requirements, ['DL-3', 'INV-6']);
});

test('marker-before-output stays silent when the turn the marker moved for wrote something', () => {
  assert.deepEqual(found(markerRoom({ output: true, recorded: true }), 'marker-before-output'), []);
});

test('marker-before-output stays silent when the person stopped the turn before its first token', () => {
  // Stop, or Send now, before any output: the turn wrote nothing by the person’s choice, not by a failure (DL-3).
  assert.deepEqual(found(markerRoom({ output: false, stopped: true }), 'marker-before-output'), []);
});

test('marker-before-output fires when the prompt is in the transcript but the turn wrote nothing, and says so', () => {
  // Claude Code writes the prompt before the model produces anything, so a saved prompt isn’t delivery: INV-6 makes
  // output the signal, because Postbox can’t tell whether a backend saved it (critic’s review of 44e69fe1). The
  // transcript’s evidence goes into the finding instead: a resend will be a labeled repeat.
  const [hit, ...rest] = found(markerRoom({ output: false, recorded: true }), 'marker-before-output');
  assert.ok(hit, 'the check fires');
  assert.deepEqual(rest, []);
  assert.match(hit.evidence, /prompt was saved to the transcript/);
  assert.match(hit.evidence, /labeled repeat/);
});

test('marker-before-output still fires with no transcript of the agent at all, as a recorded room may have none', () => {
  const f = markerRoom({ output: false });
  f.transcripts = [];
  assert.equal(found(f, 'marker-before-output').length, 1);
});

test('marker-before-output says it couldn’t check an agent on Codex, Kiro or Antigravity, whose turns aren’t in the streams it reads', () => {
  for (const backend of ['codex', 'kiro-cli', 'antigravity-cli']) {
    const r = room();
    r.agent('coder', { backend });
    r.add({ id: 'it_a', at: s(1), kind: 'user', text: 'First message' });
    r.marker('coder', null, s(0));
    r.marker('coder', 'it_a', s(10));
    // Its turn is recorded apart (streams/codex, streams/kiro, streams/agy), not in facts.streams: no turn to judge.
    const out = found(r.f, 'marker-before-output');
    assert.deepEqual(
      out.map((x) => [x.key, x.unverified?.backend]),
      [['marker-before-output:unverified:coder', backend]],
      backend,
    );
    assert.match(out[0].evidence, /1 marker move/);
  }
});

test('marker-before-output stays silent, not unverified, for a Claude Code agent whose marker moved with no turn in reach', () => {
  const r = room();
  r.agent('researcher');
  r.add({ id: 'it_a', at: s(1), kind: 'user', text: 'First message' });
  r.marker('researcher', null, s(0));
  r.marker('researcher', 'it_a', s(10));
  assert.deepEqual(found(r.f, 'marker-before-output'), []);
});
