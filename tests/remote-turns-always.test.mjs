// Always allow on a host turn's cards (#120; server/permission-cards.mjs, allowAlways, and server/host-rules.mjs): a
// rule Postbox saved in the agent's folder on this computer would never reach the host's Claude Code, and a local agent
// in that project would then follow it. So a host prompt's card offers the rule Postbox makes for the call and keeps it
// in its own store for that host (tests/host-always-rules.test.mjs follows it into the next turn), never in that folder;
// Claude Code's own suggestions on a host prompt are never read. A refusal card on a host still offers no Always allow.
// The rig is tests/remote-turns-helpers.mjs.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURE_PROMPT } from './fake-daemon.mjs';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';

/** The local settings file Postbox would write for this persona's folder on this computer. @param {any} r */
async function localRules(r) {
  const persona = r.rt.personaFor(r.se());
  const folder = await r.rt.adapters.get(persona.backend).folderFor(persona, r.rt.s.projects[r.t.projectId]);
  return join(folder, '.claude', 'settings.local.json');
}

test('#120: a host prompt’s card offers Always allow, kept for the host, and writes nothing on this computer', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'permission'), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  assert.ok(card.remote, 'a host prompt’s card');
  assert.equal(card.always.saves, 'Bash(echo hi > note.txt)', 'the rule Postbox makes for the call');
  assert.equal(card.always.updates, null, 'nothing for the host’s Claude Code to save');
  await r.rt.resolvePermission(r.t.id, card.id, 'always');
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.equal(r.d.answers[0].result.behavior, 'allow');
  assert.equal(r.d.answers[0].result.updatedPermissions, undefined);
  assert.equal(r.store.item(r.t.id, card.id).status, 'allowed-always');
  assert.deepEqual(r.rt.persona(r.se().personaId).hostRules, [{ hostId: r.host.id, rule: 'Bash(echo hi > note.txt)' }]);
  assert.equal(existsSync(await localRules(r)), false, 'nothing written here');
  r.d.end(turn);
  await settled(r);
});

test('#120: a host prompt’s Claude Code suggestions are never read: its Always allow is Postbox’s own rule', async () => {
  const r = rig();
  const turn = await running(r);
  // The SDK’s shape (PermissionUpdate); the CLI sends none, but a later version, or a copy of the prompt, might.
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }];
  r.d.prompt(turn, { ...FIXTURE_PROMPT, permission_suggestions: suggestions });
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'permission'), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  assert.equal(card.always.saves, 'Bash(echo hi > note.txt)');
  assert.equal(card.always.updates, null);
  r.rt.resolvePermission(r.t.id, card.id, 'allow');
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.equal(r.d.answers[0].result.updatedPermissions, undefined, 'no rules go back to the host');
  r.d.end(turn);
  await settled(r);
});

test('#120: a host turn’s refusal card offers Allow once and no Always allow, and refuses Always with why', async () => {
  const r = rig();
  const turn = await running(r);
  r.rt.recordDenial(r.rt.turns.get(r.se().id), { tool: 'Bash', input: { command: 'npm test' }, label: 'Run npm test', toolUseId: 'tu_refused' });
  const card = r.store.items(r.t.id).find((i) => i.kind === 'denial');
  assert.deepEqual(card.remote, { hostId: r.host.id });
  assert.ok(card.rules.once, 'Allow once stays');
  assert.equal(card.rules.always, null);
  await assert.rejects(() => r.rt.resolveDenial(r.t.id, card.id, 'always'), { status: 409, message: /runs on a host/ });
  assert.equal(existsSync(await localRules(r)), false, 'nothing written here');
  r.d.end(turn);
  await settled(r);
});
