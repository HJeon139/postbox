// The persona sheet's skills and MCP servers (#207, #59) read the latest turn's / menu and init: a session stores its
// / menu as { at, list } (recordCommands), and a sheet opened after any turn that reported one must still load.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setupRoute } from '../server/setup-routes.mjs';
import { setup } from './side-threads-fixture.mjs';

/** A session that reported its MCP servers and its / menu, as a Claude Code turn's init does. */
function reported() {
  const f = setup();
  f.rt.updateSession(f.alpha.id, { mcpServers: { at: Date.now(), servers: [] } });
  f.rt.recordCommands(f.alpha.id, [{ name: 'sample:review', skill: true }, { name: 'doctor' }]);
  return f;
}

test('the skills route reads a session’s / menu as recordCommands stores it, and lists its plugin skills', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'pb-setup-routes-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const f = reported();
  const url = new URL(`http://127.0.0.1/api/skills?personaId=${f.a.id}`);
  const res = await setupRoute(f.rt, '/api/skills', 'GET', url, home);
  assert.equal(res?.status, 200);
  assert.ok(
    res.body.skills.some((s) => s.name === 'sample:review' && s.scope === 'plugin'),
    'the plugin skill from the / menu',
  );
  assert.ok(!res.body.skills.some((s) => s.name === 'doctor'), 'a command that isn’t a skill');
});

test('mcpContext’s skills are the stored / menu’s skills, and a session with no / menu gives none', () => {
  const f = reported();
  assert.deepEqual(f.rt.mcpContext(f.a.id, 'p1').skills, ['sample:review']);
  f.rt.updateSession(f.beta.id, { mcpServers: { at: Date.now() + 1, servers: [] } });
  assert.deepEqual(f.rt.mcpContext(f.b.id, 'p1').skills, []);
});
