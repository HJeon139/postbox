// #827’s UAT trigger, host-queued-refused (tools/uat/triggers-queued.mjs): an app call an agent on a host made, which
// the host refused, came back to it as an error in the call. Built on tests/uat-hosts-facts.mjs’s run.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { HOST_TRIGGERS } from '../tools/uat/triggers-host.mjs';
import { facts } from './uat-hosts-facts.mjs';

const trigger = HOST_TRIGGERS['host-queued-refused'];
const REFUSED = 'show_app’s codePath ../outside.html is outside this turn’s folder.';
const SENT = 'Sent app app_1 to Postbox, which checks it and shows it as soon as it’s connected to this host. Use that id to update it.';

/**
 * One agent’s recorded stream with one Postbox call and its result, as Claude Code writes them.
 * @param {string} handle @param {string} name @param {{ text: string, error: boolean }} result
 */
function stream(handle, name, { text, error }) {
  const use = { type: 'tool_use', id: 'toolu_1', name: `mcp__postbox__${name}`, input: { codePath: '../outside.html' } };
  const res = { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text }], ...(error ? { is_error: true } : {}) };
  return {
    handle,
    events: [
      { type: 'assistant', timestamp: '2026-11-08T03:00:00.000Z', message: { content: [use] } },
      { type: 'user', message: { content: [res] } },
    ],
  };
}

test('#827 host-queued-refused fires when an agent on a host had its app call refused in the call', () => {
  const hits = trigger.run(facts({ streams: [stream('researcher', 'show_app', { text: REFUSED, error: true })] }));
  assert.equal(hits.length, 1);
  assert.match(hits[0].evidence, /^host1: @researcher’s show_app was refused in the call: “show_app’s codePath/);
  assert.equal(hits[0].at, Date.parse('2026-11-08T03:00:00.000Z'));
});

test('#827 host-queued-refused stays silent for a call answered “Sent”, a local agent’s refusal, and a refused block', () => {
  assert.deepEqual(trigger.run(facts({ streams: [stream('researcher', 'show_app', { text: SENT, error: false })] })), [], 'taken, as before #827');
  assert.deepEqual(trigger.run(facts({ streams: [stream('researcher', 'update_app', { text: 'Shown.', error: false })] })), [], 'answered, not refused');
  assert.deepEqual(trigger.run(facts({ streams: [stream('developer', 'show_app', { text: REFUSED, error: true })] })), [], 'not on a host');
  assert.deepEqual(trigger.run(facts({ streams: [stream('researcher', 'show_block', { text: 'Refused.', error: true })] })), [], 'not an app call');
  assert.deepEqual(trigger.run(facts()), [], 'no streams');
});

test('#827 remotehosts’ phase 7 plays a refused app call on host1', () => {
  const scenario = parseScenario(readFileSync(new URL('uat/e2e/scenarios/remotehosts.md', import.meta.url), 'utf8'));
  const phase = scenario.phases.find((p) => p.triggers.includes('host-queued-refused'));
  assert.ok(phase, 'a phase lists the trigger');
  assert.match(phase.text, /`codePath` set to `\.\.\/outside\.html`/);
  assert.equal(trigger.recorded(facts()), true);
});
