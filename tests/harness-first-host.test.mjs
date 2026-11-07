// Harness first on a host (#120): a host turn in Auto gets no write ask rules of Postbox’s in its --settings, so the
// host’s Claude Code decides; a card shows only for the host harness’s own prompt. Ask me keeps Postbox’s write asks
// there too. The local side is tests/harness-first.test.mjs; the rig is tests/remote-turns-helpers.mjs. Always allow
// on a host card is tests/harness-first-host-always.test.mjs: Postbox keeps the rule and sends it in that host turn’s
// --settings (server/host-rules.mjs), and writes nothing on the host.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WRITE_TOOLS } from '../server/adapters/setup.mjs';
import { rig, running, settled, starts, until } from './remote-turns-helpers.mjs';

/** The rig, with its persona in this mode. @param {string} permissionMode */
function rigIn(permissionMode) {
  const r = rig();
  r.rt.updatePersona(r.rt.personaFor(r.se()).id, { permissionMode });
  return r;
}
/** The ask rules the host’s Claude Code got for a start, from its --settings. */
const askOf = (start) => JSON.parse(start.argv[start.argv.indexOf('--settings') + 1]).permissions?.ask ?? [];

test('a host turn in Auto gets no write ask rule of Postbox’s in its settings', async () => {
  const r = rigIn('auto');
  const turn = await running(r);
  const start = starts(r.d).at(-1);
  assert.equal(start.argv[start.argv.indexOf('--permission-mode') + 1], 'auto');
  assert.deepEqual(
    askOf(start).filter((rule) => WRITE_TOOLS.includes(rule)),
    [],
  );
  r.d.end(turn);
  await settled(r);
});

test('a host turn in Ask me still gets every write ask rule', async () => {
  // Passes on main by design: Ask me keeps Postbox’s write asks.
  const r = rigIn('ask');
  const turn = await running(r);
  assert.deepEqual(askOf(starts(r.d).at(-1)), WRITE_TOOLS);
  r.d.end(turn);
  await settled(r);
});

test('in Auto, the host harness’s own prompt still makes a card', async () => {
  // Passes on main by design: the harness’s own ask keeps its card.
  const r = rigIn('auto');
  const turn = await running(r);
  r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'permission'), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  assert.ok(card.remote, 'a host prompt’s card');
  r.rt.resolvePermission(r.t.id, card.id, 'allow');
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.equal(r.d.answers[0].result.behavior, 'allow');
  r.d.end(turn);
  await settled(r);
});
