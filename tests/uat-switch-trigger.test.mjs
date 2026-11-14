// The backend-switch scenarios’ triggers (tools/uat/switch-triggers.mjs, #1315): after a switch saved in the persona
// sheet, the agent’s next turn is recorded by the chosen backend and reports the chosen model and effort, and its row
// names them. Read from what a run records: a real Runtime’s events cut as the run’s history keeps them, each turn’s
// recorded stream (a recorded fixture, written by recorderFor into the backend’s folder and read by readStreams), and
// the switch as the runner’s agent_panel action records it.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { recorderFor } from '../server/adapters/setup.mjs';
import { keepEvent } from '../tools/uat/history.mjs';
import { PANEL_CHECKS } from '../tools/uat/room-checks-panels.mjs';
import { readStreams } from '../tools/uat/run-files.mjs';
import { compatBackends, parseScenario } from '../tools/uat/scenario.mjs';
import { TRIGGERS, unknownTriggers } from '../tools/uat/triggers.mjs';
import { settle, setup, sleep } from './side-threads-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

/** Each backend’s folder under a run’s streams/, its facts key, and a recorded turn of it. */
const BACKENDS = {
  'claude-code': ['', 'streams', 'claude-code/block.jsonl'],
  'agent-sdk': ['sdk', 'sdkStreams', 'claude-code/block.jsonl'],
  codex: ['codex', 'codexStreams', 'codex-app-server/ask-mcp-allow.jsonl'],
  'kiro-cli': ['kiro', 'kiroStreams', 'kiro-cli/auto-shell.jsonl'],
  'antigravity-cli': ['agy', 'agyStreams', 'antigravity-cli/first.jsonl'],
};
const NAMES = { 'claude-code': 'Claude Code', 'agent-sdk': 'Agent SDK', codex: 'Codex', 'kiro-cli': 'Kiro CLI', 'antigravity-cli': 'Antigravity CLI' };
const fixture = (name) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean);

/** A room with @alpha, recorded as a run records it. */
function room() {
  const r = setup();
  const dir = tempDir('pb-switch-run-');
  // Made up front, as the runner makes them (tools/uat/run-files.mjs, runPaths).
  for (const [sub] of Object.values(BACKENDS)) mkdirSync(join(dir, sub), { recursive: true });
  const events = [];
  const sessions = new Map(Object.entries(r.store.state.sessions));
  r.store.subscribe((ev) => {
    const kept = keepEvent(ev.seq, ev.type, ev.data, sessions);
    if (kept) events.push(kept);
  });
  const panels = [];
  let row = null;
  return {
    /** The person saves a switch in @alpha’s sheet, as agent_panel records it. */
    async save(backend, model, effort) {
      await sleep(2);
      panels.push({
        handle: 'alpha',
        set: { backend: NAMES[backend], model, effort },
        left: { saved: true, backend: NAMES[backend], model, effort },
        at: Date.now(),
      });
      await sleep(2);
    },
    /** @alpha takes a turn that `backend` records, and reports `reported` (ctx.reported), if anything. */
    async turn(backend, reported) {
      const [sub, , file] = BACKENDS[backend];
      r.adapter.next.push(async (c) => {
        const record = recorderFor(c, join(dir, sub));
        for (const l of fixture(file)) record(l);
        if (reported) c.reported(reported);
        c.text('ok');
      });
      r.rt.sendMessage(r.t.id, { text: '@alpha say ok' });
      await settle(r.rt);
    },
    /** What @alpha’s row in the Agents section says now. */
    row(text) {
      row = text;
    },
    facts() {
      const f = { probes: { panels }, events, ui: { agentLines: row ? { alpha: row } : {} } };
      for (const [sub, key] of Object.values(BACKENDS)) f[key] = readStreams(join(dir, sub));
      return f;
    },
  };
}

const fired = (id, f) => TRIGGERS[id].run(f);

test('ran-sdk-sonnet-low fires when the turn after the switch is in streams/sdk and reports Sonnet at low effort', async () => {
  const r = room();
  await r.turn('claude-code', { model: 'claude-opus-5-5', effort: 'medium' });
  await r.save('agent-sdk', 'claude-sonnet-5-5', 'low');
  await r.turn('agent-sdk', { model: 'claude-sonnet-5-5', effort: 'low' });
  const [hit, ...rest] = fired('ran-sdk-sonnet-low', r.facts());
  assert.deepEqual(rest, []);
  assert.equal(
    hit.evidence,
    '@alpha saved agent-sdk · claude-sonnet-5-5 · low; its next turn is in streams/sdk/, which reported claude-sonnet-5-5 at low effort.',
  );
});

test('ran-sdk-sonnet-low doesn’t fire when Claude Code recorded the turn after a switch to the Agent SDK', async () => {
  const r = room();
  await r.save('agent-sdk', 'claude-sonnet-5-5', 'low');
  await r.turn('claude-code', { model: 'claude-sonnet-5-5', effort: 'low' });
  assert.deepEqual(fired('ran-sdk-sonnet-low', r.facts()), []);
});

test('ran-sdk-sonnet-low doesn’t fire when the backend reported another model, or another effort', async () => {
  const r = room();
  await r.save('agent-sdk', 'claude-sonnet-5-5', 'low');
  await r.turn('agent-sdk', { model: 'claude-opus-5-5', effort: 'low' });
  assert.deepEqual(fired('ran-sdk-sonnet-low', r.facts()), [], 'Opus answered');
  const s = room();
  await s.save('agent-sdk', 'claude-sonnet-5-5', 'low');
  await s.turn('agent-sdk', { model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.deepEqual(fired('ran-sdk-sonnet-low', s.facts()), [], 'it ran at medium');
});

test('a turn counts only for the switch before it: one before the switch, or after the next switch, doesn’t', async () => {
  const r = room();
  await r.turn('agent-sdk', { model: 'claude-sonnet-5-5', effort: 'low' });
  await r.save('agent-sdk', 'claude-sonnet-5-5', 'low');
  await r.save('claude-code', 'claude-haiku-5-5', 'high');
  await r.turn('agent-sdk', { model: 'claude-sonnet-5-5', effort: 'low' });
  assert.deepEqual(fired('ran-sdk-sonnet-low', r.facts()), [], 'no turn came between the switch and the next one');
  assert.deepEqual(fired('ran-cc-haiku-high', r.facts()), [], 'the turn after the Claude Code switch ran on the SDK');
});

test('ran-kiro-auto-high fires on the backend alone, since Kiro reports no model on its router', async () => {
  const r = room();
  await r.turn('claude-code', { model: 'claude-opus-5-5', effort: 'medium' });
  await r.save('kiro-cli', 'auto', 'high');
  await r.turn('kiro-cli', null);
  const [hit] = fired('ran-kiro-auto-high', r.facts());
  assert.match(hit.evidence, /^@alpha saved kiro-cli · auto · high; its next turn is in streams\/kiro\//);
});

test('shown-codex-auto-high fires when the row names the model Codex reported and high effort, and not when it says “not”', async () => {
  const r = room();
  await r.save('codex', 'auto', 'high');
  await r.turn('codex', { model: 'gpt-6-luna', effort: 'high' });
  r.row('alpha · idle gpt-6-luna · high effort');
  const [hit] = fired('shown-codex-auto-high', r.facts());
  assert.equal(hit.evidence, '@alpha saved codex · auto · high; its row says “alpha · idle gpt-6-luna · high effort”.');
  r.row('alpha · idle gpt-6-luna, not auto · high effort');
  assert.deepEqual(fired('shown-codex-auto-high', r.facts()), [], 'it says “not”');
  r.row('alpha · idle Codex’s default · high effort');
  assert.deepEqual(fired('shown-codex-auto-high', r.facts()), [], 'the model Codex reported never reached the row');
});

test('shown-kiro-auto-high doesn’t fire while the row still names the model of the backend before it', async () => {
  const r = room();
  await r.turn('claude-code', { model: 'claude-opus-5-5', effort: 'medium' });
  await r.save('kiro-cli', 'auto', 'high');
  await r.turn('kiro-cli', null);
  r.row('alpha · idle Opus 5.5, not auto · medium effort, set to high');
  assert.deepEqual(fired('shown-kiro-auto-high', r.facts()), []);
  r.row('alpha · idle auto · high effort');
  assert.equal(fired('shown-kiro-auto-high', r.facts()).length, 1);
});

test('shown-sdk-sonnet-low waits for a turn after the switch, and reads the row only for the agent’s latest switch', async () => {
  const r = room();
  await r.save('agent-sdk', 'claude-sonnet-5-5', 'low');
  r.row('alpha · idle Sonnet 5.5 · low effort');
  assert.deepEqual(fired('shown-sdk-sonnet-low', r.facts()), [], 'no turn yet');
  await r.turn('agent-sdk', { model: 'claude-sonnet-5-5', effort: 'low' });
  assert.equal(fired('shown-sdk-sonnet-low', r.facts()).length, 1);
  await r.save('claude-code', 'claude-haiku-5-5', 'high');
  assert.deepEqual(fired('shown-sdk-sonnet-low', r.facts()), [], 'the row now belongs to the later switch');
});

test('the switch scenarios name only triggers that exist', () => {
  for (const name of ['switch', 'switch-compat']) {
    const s = parseScenario(readFileSync(new URL(`uat/e2e/scenarios/${name}.md`, import.meta.url), 'utf8'));
    assert.deepEqual(unknownTriggers(s), [], name);
    assert.ok(
      s.phases.every((p) => p.triggers?.length),
      `${name}: every phase names its triggers`,
    );
  }
});

test('a scenario that switches an agent to Codex, Kiro or Antigravity is a compatibility run; one that stays on Claude isn’t', () => {
  const backends = (name) => compatBackends(parseScenario(readFileSync(new URL(`uat/e2e/scenarios/${name}.md`, import.meta.url), 'utf8')));
  assert.deepEqual(backends('switch'), []);
  assert.deepEqual(backends('switch-compat'), ['codex', 'kiro-cli', 'antigravity-cli']);
});

// The switch checks (tools/uat/room-checks-panels.mjs) read the same switches, and say what went wrong.
const check = (id, f) => PANEL_CHECKS.find((c) => c.id === id).run(f);

test('switch-takes-effect says which backend recorded the turn after a switch, and which model it reported, when they aren’t the ones saved', async () => {
  const r = room();
  await r.save('agent-sdk', 'claude-sonnet-5-5', 'low');
  await r.turn('claude-code', { model: 'claude-sonnet-5-5', effort: 'low' });
  assert.deepEqual(
    check('switch-takes-effect', r.facts()).map((x) => x.evidence),
    ['@alpha saved agent-sdk · claude-sonnet-5-5 · low; its next turn is in streams/, where Claude Code records its turns.'],
  );
  const s = room();
  await s.save('agent-sdk', 'claude-sonnet-5-5', 'low');
  await s.turn('agent-sdk', { model: 'claude-opus-5-5', effort: 'low' });
  assert.deepEqual(
    check('switch-takes-effect', s.facts()).map((x) => x.evidence),
    ['@alpha saved agent-sdk · claude-sonnet-5-5 · low; its next turn reported claude-opus-5-5.'],
  );
  const ok = room();
  await ok.save('codex', 'auto', 'high');
  await ok.turn('codex', { model: 'gpt-6-luna', effort: 'high' });
  assert.deepEqual(check('switch-takes-effect', ok.facts()), [], 'Codex’s default is whichever model it picks');
});

test('switch-shown flags a row that still says “not” after the turn, and stays quiet once it names the setting', async () => {
  const r = room();
  await r.turn('claude-code', { model: 'claude-opus-5-5', effort: 'medium' });
  await r.save('kiro-cli', 'auto', 'high');
  await r.turn('kiro-cli', null);
  r.row('alpha · idle Opus 5.5, not auto · medium effort, set to high');
  assert.deepEqual(
    check('switch-shown', r.facts()).map((x) => x.evidence),
    ['@alpha saved kiro-cli · auto · high, and took a turn on kiro-cli; its row says “alpha · idle Opus 5.5, not auto · medium effort, set to high”.'],
  );
  r.row('alpha · idle auto · high effort');
  assert.deepEqual(check('switch-shown', r.facts()), []);
});

test('a shown- trigger can’t be checked from facts without the agents’ rows, as a recheck has them', async () => {
  const r = room();
  await r.save('codex', 'auto', 'high');
  const f = { ...r.facts(), ui: {} };
  assert.equal(TRIGGERS['shown-codex-auto-high'].recorded(f), false);
  assert.equal(TRIGGERS['shown-codex-auto-high'].recorded(r.facts()), true);
});
