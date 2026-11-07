// Harness first on a host, lead-state’s part: a card from the host harness’s own prompt offers Always allow, with the
// rule alwaysFor makes for the call (today hostAlways, server/permission-cards.mjs, offers none on a host). Where the
// saved rule lives is the fix’s decision; this pins only what the card offers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXTURE_PROMPT } from './fake-daemon.mjs';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';

test('a host card from the harness’s own prompt offers Always allow, with the rule alwaysFor makes for the call', async () => {
  const r = rig();
  r.rt.updatePersona(r.rt.personaFor(r.se()).id, { permissionMode: 'auto' });
  const turn = await running(r);
  r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'permission'), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  // The host prompt carries no suggestions Postbox reads (turns-prompts.mjs, cardFor), so the rule is the one made from
  // the call the stream showed.
  const want = r.rt.alwaysFor(r.se(), { tool: FIXTURE_PROMPT.tool_name, input: FIXTURE_PROMPT.input, suggestions: undefined, suppressAlways: false });
  assert.ok(want, 'alwaysFor has a rule for this call');
  assert.deepEqual(card.always, want);
  r.rt.resolvePermission(r.t.id, card.id, 'allow');
  await until(() => r.d.answers.length === 1, 'the answer');
  r.d.end(turn);
  await settled(r);
});
