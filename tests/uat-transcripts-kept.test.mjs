// The run folder keeps the agents’ transcript lines the checks read (#508, #523): each agent’s user lines, in
// <run>/transcripts/<handle>.jsonl, so --recheck reads what a live run read, after the agents’ Claude Code
// transcripts have gone. The room is hand-built from the shapes UAT runs record (tests/delivery-fixture.mjs).

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runChecks } from '../tools/uat/checks.mjs';
import { keepTranscripts, savedTranscripts, transcriptsFor } from '../tools/uat/run-files.mjs';
import { runStop } from '../tools/uat/stop.mjs';
import { TRIGGERS } from '../tools/uat/triggers.mjs';
import { DRAFT, ROUND_TWO, room, T0 } from './delivery-fixture.mjs';

const s = (n) => T0 + n * 1000;
const DELIVERY = ['delivery-dropped', 'unlabeled-repeat', 'marker-before-output', 'ask-dropped'];
const TRIGGER_IDS = ['held-behind-card', 'held-released', 'mention-past-cap', 'edit-while-waiting', 'fail-before-output', 'resend-labeled'];

/** A room with a dropped mention, a bare repeat and a resend, and each agent’s replies in its transcript too. */
function liveRoom() {
  const r = room();
  r.agent('researcher');
  r.agent('critic');
  r.add({ id: 'it_draft', at: s(1), kind: 'user', text: DRAFT });
  r.turn('researcher', s(2), { prompt: DRAFT, results: ['the release log, read'] });
  r.turn('researcher', s(30), { prompt: `[Postbox] What happened in this room since your last turn:\n\nYou: ${DRAFT}` });
  r.add({ id: 'it_round2', at: s(40), kind: 'agent', handle: 'researcher', sessionId: 'se_researcher', text: `@critic ${ROUND_TWO}` });
  r.turn('critic', s(50), { prompt: '[Postbox] You: anything?' });
  r.turn('critic', s(60), { prompt: '[Postbox] You: anything else?' });
  // What Claude Code writes besides: the agent’s own replies, which no check reads, and a line cut short.
  for (const t of r.f.transcripts) {
    t.lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date(s(70)).toISOString(), message: { content: [{ type: 'text', text: 'my reply' }] } }));
    t.lines.push('{"type":"user","timest');
  }
  return r.f;
}

const results = (f) => ({
  checks: runChecks(f, { only: DELIVERY }),
  triggers: Object.fromEntries(TRIGGER_IDS.map((id) => [id, TRIGGERS[id].run(f)])),
});

test('a run folder’s kept transcripts give the delivery checks and triggers what the live run gave them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uat-kept-'));
  try {
    const live = liveRoom();
    keepTranscripts(dir, live.transcripts);
    assert.deepEqual(readdirSync(join(dir, 'transcripts')).sort(), ['critic.jsonl', 'researcher.jsonl']);
    const kept = readFileSync(join(dir, 'transcripts', 'researcher.jsonl'), 'utf8');
    assert.doesNotMatch(kept, /"type":"assistant"|my reply/, 'only the user lines the checks read');
    const offline = { ...live, transcripts: savedTranscripts(dir) };
    const want = results(live);
    assert.ok(
      want.checks.some((x) => x.check === 'delivery-dropped') && want.checks.some((x) => x.check === 'unlabeled-repeat'),
      'the room has findings to compare',
    );
    assert.deepEqual(results(offline), want);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recheck reads the kept transcripts when the run folder has them, and the agents’ own otherwise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uat-kept-'));
  try {
    const live = liveRoom();
    // No session here names a Claude Code transcript, so without kept ones there’s nothing to read.
    const facts = { state: live.state, threads: live.threads };
    assert.equal(savedTranscripts(dir), null);
    assert.deepEqual(transcriptsFor(dir, facts), []);
    keepTranscripts(dir, live.transcripts);
    assert.deepEqual(
      transcriptsFor(dir, facts)
        .map((t) => t.handle)
        .sort(),
      ['critic', 'researcher'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run’s stop keeps the transcripts first, and stops all the same when keeping them fails', async () => {
  /** @type {string[]} */
  const said = [];
  const run = {
    keep: () => said.push('kept'),
    page: { close: async () => void said.push('page closed') },
    postbox: { kill: async () => void said.push('postbox exited') },
    log: (/** @type {string} */ l) => said.push(l),
  };
  await runStop(run)();
  assert.deepEqual(said, ['kept', 'page closed', 'postbox exited']);
  said.length = 0;
  await runStop({
    ...run,
    keep: () => {
      throw new Error('disk full');
    },
  })();
  assert.deepEqual(said, ['Couldn’t keep the agents’ transcripts: disk full', 'page closed', 'postbox exited']);
});
