// The trigger for #694 (tools/uat/waiting-triggers.mjs): it fires on a turn whose Postbox tool result named a newer
// waiting message from the sender it was answering, and stays silent on one whose results didn’t. The streams are
// built inline, in the shape a Claude Code turn records (tools/uat/postbox-calls.mjs reads them).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TRIGGERS } from '../tools/uat/triggers.mjs';

const T0 = Date.parse('2026-11-03T22:00:00Z');

/** One turn of @developer that called define_term once, and was answered with `text`. */
function streams(text) {
  const at = new Date(T0 + 5000).toISOString();
  const call = { type: 'tool_use', id: 'toolu_1', name: 'mcp__postbox__define_term', input: { term: 'X', definition: 'Y' } };
  const result = { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text }] };
  const events = [
    { type: 'assistant', timestamp: at, message: { content: [call] } },
    { type: 'user', message: { content: [result] } },
  ];
  return { streams: [{ handle: 'developer', started: T0, events }] };
}

const NAMED = '[Postbox] A newer message from the person is waiting for you; it reaches you when this turn ends, unless it’s removed.\n\nDefined “X”.';

test('#694: newer-waiting-named fires when a tool result named a newer message from the turn’s sender', () => {
  const out = TRIGGERS['newer-waiting-named'].run(streams(NAMED));
  assert.equal(out.length, 1);
  assert.equal(out[0].at, T0 + 5000);
  assert.equal(out[0].evidence, '@developer’s define_term result named a newer message from the person.');
});

test('#694: newer-waiting-named stays silent when no result named one, and a run without streams can’t show it', () => {
  assert.deepEqual(TRIGGERS['newer-waiting-named'].run(streams('Defined “X”.')), []);
  assert.equal(TRIGGERS['newer-waiting-named'].recorded({}), false);
  assert.equal(TRIGGERS['newer-waiting-named'].recorded(streams(NAMED)), true);
});

test('#694: a note quoted in a result’s body, such as read_message’s, isn’t the note', () => {
  assert.deepEqual(TRIGGERS['newer-waiting-named'].run(streams(`Item it_1:\n\n${NAMED}`)), []);
});

test('#694: newer-waiting-named fires on a note naming an agent, too', () => {
  const out = TRIGGERS['newer-waiting-named'].run(
    streams('[Postbox] A newer message from @critic is waiting for you; read_message { id: "it_1" } has it.\n\nDefined “X”.'),
  );
  assert.equal(out[0]?.evidence, '@developer’s define_term result named a newer message from @critic.');
});
