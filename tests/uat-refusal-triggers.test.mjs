// #1319's UAT check and triggers: a malformed app or block is refused with nothing left in the room, and the agent
// then shows it fixed. Read from a room made by a real Runtime, with the calls recorded as Claude Code’s stream
// records them (tools/uat/postbox-calls.mjs), each carrying the reply the Runtime gave.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { POSTBOX_SERVER } from '../server/adapters/setup.mjs';
import { CHECKS } from '../tools/uat/room-checks.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { TRIGGERS, unknownTriggers } from '../tools/uat/triggers.mjs';
import { setup, turn } from './blocks-fixture.mjs';

const CHECK = CHECKS.find((c) => c.id === 'broken-block-card');
const APP = { id: 'sales', title: 'Weekly sales', code: '<svg></svg>' };
const OPTIONS = [
  { id: 'mon', label: 'Monday' },
  { id: 'fri', label: 'Friday' },
];
const form = (options, fallback) => ({
  id: 'promote',
  type: 'form',
  version: 1,
  ...(fallback ? { fallback } : {}),
  fields: [{ id: 'day', label: 'Day', kind: 'select', options }],
});

/** Runs the agent’s calls in one turn, and records each as a stream records it, with the Runtime’s reply. */
async function room(calls) {
  const r = setup();
  const events = [];
  await turn(r.rt, r.adapter, r.t, (tools) => {
    calls.forEach(([name, input], i) => {
      const out = tools[name](input);
      const id = `toolu_${i}`;
      events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__${POSTBOX_SERVER}__${name}`, input }] } });
      events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: out.ok === false, content: out.message }] } });
    });
  });
  const facts = {
    threads: [r.t.id],
    state: { items: { [r.t.id]: r.store.items(r.t.id) }, sessions: r.store.state.sessions },
    streams: [{ handle: 'critic', events }],
  };
  return { ...r, facts };
}

test('#1319 a malformed app refused, then shown fixed, fires app-refused-then-shown and leaves no broken card', async () => {
  const { facts } = await room([
    ['show_app', { ...APP, permissions: ['Read Files'] }],
    ['show_app', { ...APP, permissions: [] }],
  ]);
  const [fired] = TRIGGERS['app-refused-then-shown'].run(facts);
  assert.match(fired?.evidence ?? '', /@critic’s show_app of sales was refused \(“permissions\[0\] isn’t a valid tool name\./);
  assert.match(fired.evidence, /then its show_app of sales was taken: “Shown app sales/);
  assert.deepEqual(TRIGGERS['block-refused-then-shown'].run(facts), [], 'an app isn’t a block here');
  assert.deepEqual(CHECK.run(facts), []);
});

test('#1319 a form with string options refused, then shown fixed, fires block-refused-then-shown', async () => {
  const { facts } = await room([
    ['show_block', { block: form(['Monday', 'Friday']) }],
    ['show_block', { block: form(OPTIONS, 'Which day: Monday or Friday?') }],
  ]);
  const [fired] = TRIGGERS['block-refused-then-shown'].run(facts);
  assert.match(fired?.evidence ?? '', /fallback is required\./);
  assert.match(fired.evidence, /“Shown block promote\.”/);
  assert.deepEqual(TRIGGERS['app-refused-then-shown'].run(facts), []);
});

test('#1319 a refusal followed by another block or app taken under a new id fires nothing', async () => {
  // As agents did before #1319: the broken one left behind, a fresh id shown beside it. That isn’t the refused one fixed.
  const apps = await room([
    ['show_app', { ...APP, permissions: ['Read Files'] }],
    ['show_app', { ...APP, id: 'sales-2', permissions: [] }],
  ]);
  assert.deepEqual(TRIGGERS['app-refused-then-shown'].run(apps.facts), []);
  const blocks = await room([
    ['show_block', { block: form(['Monday', 'Friday']) }],
    ['show_block', { block: { ...form(OPTIONS, 'Which day?'), id: 'promote-2' } }],
  ]);
  assert.deepEqual(TRIGGERS['block-refused-then-shown'].run(blocks.facts), []);
});

test('#1319 a refusal the agent never fixed fires nothing', async () => {
  const { facts } = await room([['show_app', { ...APP, permissions: ['Read Files'] }]]);
  assert.deepEqual(TRIGGERS['app-refused-then-shown'].run(facts), []);
});

test('#1319 broken-block-card flags an invalid block left in the room, as main before #1319 posted it, and nothing else', async () => {
  const { facts, rt, t, store } = await room([['show_block', { block: form(OPTIONS, 'Which day?') }]]);
  assert.deepEqual(CHECK.run(facts), []);
  const se = Object.values(store.state.sessions)[0];
  const card = { kind: 'block', sessionId: se.id, handle: 'critic', turnId: null, valid: false, fallback: 'x' };
  rt.addItem(t.id, { ...card, raw: { id: 'promote-2', type: 'form' }, errors: ['fallback is required.'], reason: 'invalid' });
  // A newer host’s block this Postbox can’t read still shows its fallback on purpose.
  rt.addItem(t.id, { ...card, raw: { id: 'map', type: 'map' }, errors: ['Unknown type “map”.'], reason: 'unknown-type' });
  const after = { ...facts, state: { ...facts.state, items: { [t.id]: store.items(t.id) } } };
  assert.deepEqual(
    CHECK.run(after).map((x) => x.evidence),
    ['@critic’s form “promote-2”: fallback is required.'],
  );
  assert.deepEqual(TRIGGERS['block-refused-then-shown'].run(after), [], 'no trigger while a broken card is in the room');
});

test('#1319 the malformedapp scenario’s phases name only triggers that exist', () => {
  const s = parseScenario(readFileSync(new URL('uat/e2e/scenarios/malformedapp.md', import.meta.url), 'utf8'));
  assert.deepEqual(unknownTriggers(s), []);
  assert.deepEqual(
    s.phases.map((p) => p.triggers),
    [['app-refused-then-shown'], ['block-refused-then-shown']],
  );
});
