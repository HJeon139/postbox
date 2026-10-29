// The delivery checks on an agent whose inputs they can’t read (#508): Codex, Kiro and Antigravity agents have no
// Claude Code transcript, and a Claude Code agent may have none recorded. A check there says it couldn’t check, as a
// record that isn’t a defect, and the report lists it by agent and backend, so a skipped check never reads as a pass.
// The rooms are hand-built (tests/delivery-fixture.mjs says why, and from which shapes).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { liveChecks } from '../server/room-checks.mjs';
import { runChecks } from '../tools/uat/checks.mjs';
import { writeReport } from '../tools/uat/report.mjs';
import { DRAFT, ROUND_TWO, room, T0 } from './delivery-fixture.mjs';

const s = (n) => T0 + n * 1000;
const found = (f, id) => runChecks(f, { only: [id] });

/** The record a check leaves for an agent whose inputs it can’t read: visible, and not a defect. */
function notCheckable(out, check, handle, backend, name) {
  assert.equal(out.length, 1, JSON.stringify(out));
  const [x] = out;
  assert.equal(x.key, `${check}:unverified:${handle}`);
  assert.match(x.title, new RegExp(`^${check} isn’t checkable for @${handle} on ${name}`));
  assert.equal(x.issue, null);
  assert.equal(x.verdict, 'measurement');
  assert.deepEqual(x.unverified, { check, handle, backend });
}

/** @critic mentions @researcher, on this backend, which then takes two turns. */
function mentionRoom(backend, { transcript = true } = {}) {
  const r = room();
  r.agent('researcher', { backend });
  r.agent('critic');
  if (!transcript) r.f.transcripts = r.f.transcripts.filter((t) => t.handle !== 'researcher');
  r.add({ id: 'it_round2', at: s(10), kind: 'agent', handle: 'critic', sessionId: 'se_critic', text: ROUND_TWO });
  r.turn('researcher', s(20));
  r.turn('researcher', s(40));
  return r.f;
}

test('delivery-dropped says it can’t check a Claude Code agent with no transcript, rather than nothing', () => {
  notCheckable(found(mentionRoom('claude-code', { transcript: false }), 'delivery-dropped'), 'delivery-dropped', 'researcher', 'claude-code', 'Claude Code');
});

test('delivery-dropped says it can’t check an agent on Codex, Kiro or Antigravity, whose prompts no transcript records', () => {
  for (const [backend, name] of [
    ['codex', 'Codex'],
    ['kiro-cli', 'Kiro'],
    ['antigravity-cli', 'Antigravity'],
  ])
    notCheckable(found(mentionRoom(backend), 'delivery-dropped'), 'delivery-dropped', 'researcher', backend, name);
});

test('delivery-dropped still checks the Claude Code agents beside one it can’t', () => {
  const f = mentionRoom('codex');
  const r = room();
  r.agent('writer');
  r.add({ id: 'it_ask', at: s(10), kind: 'user', text: `@writer ${DRAFT}` });
  r.turn('writer', s(20), { prompt: '[Postbox] You: are we done?' });
  r.turn('writer', s(40), { prompt: '[Postbox] You: are we done?' });
  Object.assign(f.state.personas, r.f.state.personas);
  Object.assign(f.state.sessions, r.f.state.sessions);
  f.state.threads.th_room.members.push(...r.f.state.threads.th_room.members);
  f.state.items.th_room.push(...r.f.state.items.th_room);
  f.streams.push(...r.f.streams);
  f.transcripts.push(...r.f.transcripts);
  assert.deepEqual(
    found(f, 'delivery-dropped').map((x) => x.key),
    ['delivery-dropped:unverified:researcher', 'delivery-dropped:writer:it_ask'],
  );
});

test('unlabeled-repeat says it can’t check an agent on Kiro, whose prompts no transcript records', () => {
  const r = room();
  r.agent('researcher', { backend: 'kiro-cli' });
  r.add({ id: 'it_draft', at: s(1), kind: 'user', text: DRAFT });
  r.turn('researcher', s(2));
  notCheckable(found(r.f, 'unlabeled-repeat'), 'unlabeled-repeat', 'researcher', 'kiro-cli', 'Kiro');
});

test('ask-dropped says it can’t check a held wake whose agent is on Antigravity, rather than calling it arrived', () => {
  // A card from @critic to @writer, with @critic’s wake of @researcher held on it, retired when @writer was woken.
  const r = room();
  r.agent('researcher', { backend: 'antigravity-cli' });
  r.agent('critic');
  r.agent('writer');
  r.add({ id: 'it_card', at: s(1), kind: 'hop', from: 'critic', fromSessionId: 'se_critic', to: 'writer', text: '@writer please edit', status: 'open' });
  r.patch('it_card', { held: [{ fromSessionId: 'se_critic', from: 'critic', to: 'researcher', text: ROUND_TWO, at: s(5) }] });
  r.patch('it_card', { status: 'retired', retiredAt: s(9) });
  r.turn('writer', s(10), { prompt: '@writer please edit' });
  r.turn('researcher', s(12));
  notCheckable(found(r.f, 'ask-dropped'), 'ask-dropped', 'researcher', 'antigravity-cli', 'Antigravity');
});

test('the report lists each check it couldn’t make, by agent and backend, apart from the new findings', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'uat-unverified-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const findings = runChecks(mentionRoom('codex'), { only: ['delivery-dropped', 'unlabeled-repeat'] }).map((x) => ({ ...x, source: 'check', step: 3 }));
  t.mock.method(console, 'log', () => {});
  await writeReport({
    dir,
    scenario: { title: 'Delivery' },
    issues: [],
    findings,
    timeline: [],
    started: 0,
    tester: { spent: 0 },
    facts: { streams: [], kiroStreams: [], agyStreams: [], state: null, probes: {}, samples: [] },
    logLines: [],
  });
  const md = readFileSync(join(dir, 'report.md'), 'utf8');
  assert.match(md, /## Checks not verified/);
  assert.match(md, /\| delivery-dropped \| @researcher \| Codex \| DL-1, SW-2 \|/);
  assert.match(md, /\| unlabeled-repeat \| @researcher \| Codex \| DL-2, INV-4 \|/);
  const fresh = md.slice(md.indexOf('## New findings'), md.indexOf('## Timeline'));
  assert.doesNotMatch(fresh, /isn’t checkable/);
});

test('a recorded room’s checks keep what they couldn’t check apart from their findings, so telemetry never counts it found', () => {
  const live = liveChecks(mentionRoom('codex'));
  assert.deepEqual(
    live.findings.filter((x) => x.check === 'delivery-dropped' || x.check === 'unlabeled-repeat'),
    [],
  );
  assert.deepEqual(
    live.unverified.map((x) => x.key),
    ['delivery-dropped:unverified:researcher', 'unlabeled-repeat:unverified:researcher'],
  );
});
