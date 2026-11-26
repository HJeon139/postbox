// #136, re-scoped as #416’s option A: in Auto, a Kiro agent runs what its persona’s Tools allow with no refusal, since
// Kiro has no Auto of its own and Postbox’s rules are its harness. Kiro reads deny over ask over allow, whatever the
// scope, so every deny kiroRules writes still holds: unticked Tools, publishing, servers turned off, Isolated. And
// with every edit allowed in the agent’s folders, edits of their .kiro and .git are denied, in Auto and Accept edits:
// a .kiro/settings/mcp.json the agent wrote would start any command as an MCP server on its next turn, and a
// .git/config can name a program git runs. The design is sprint4/136-packet-r1.md v2.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KIRO_PUBLISHING, kiroRules } from '../server/adapters/kiro-cli-agent.mjs';

const folders = ['/nowhere/agent', '/nowhere/project'];
const rules = (persona) => kiroRules({ persona, folders, resolve: false });
const has = (list, capability, effect, match) =>
  list.some((r) => r.capability === capability && r.effect === effect && (match === undefined || JSON.stringify(r.match) === JSON.stringify(match)));
const guarded = folders.flatMap((d) => [`${d}/.kiro`, `${d}/.git`]);

test('#136 in Auto, what the persona’s Tools allow is allowed: commands, web, MCP tools, and edits in its folders', () => {
  const auto = rules({ permissionMode: 'auto', tools: ['shell', 'web.fetch'], canPublish: true });
  for (const c of ['shell', 'web_fetch', 'web_search']) assert.ok(has(auto, c, 'allow', ['*']), c);
  assert.ok(has(auto, 'mcp', 'allow', ['*/*']), 'MCP tools');
  assert.ok(has(auto, 'fs_write', 'allow', folders), 'edits in its folders');
  assert.ok(!auto.some((r) => r.effect === 'deny' && r.capability !== 'fs_write'), 'nothing it may use is denied');
});

test('#136 a persona with no mode is in Auto, as everywhere in Postbox', () => {
  assert.ok(has(rules({ tools: ['shell'] }), 'shell', 'allow', ['*']));
});

test('#136 in Auto, an unticked Tool stays denied, with no allow beside it', () => {
  const auto = rules({ permissionMode: 'auto', tools: [] });
  for (const c of ['shell', 'web_fetch', 'web_search']) {
    assert.ok(has(auto, c, 'deny'), `${c} denied`);
    assert.ok(!has(auto, c, 'allow'), `${c} not allowed`);
  }
});

test('#136 in Auto, a persona that can’t publish keeps the publishing deny beside the MCP allow', () => {
  const auto = rules({ permissionMode: 'auto', tools: ['shell'] });
  assert.ok(has(auto, 'mcp', 'allow', ['*/*']));
  assert.ok(auto.some((r) => r.capability === 'mcp' && r.effect === 'deny' && r.match === KIRO_PUBLISHING));
});

test('#136 with edits allowed, in Auto and Accept edits, edits of each folder’s .kiro and .git are denied', () => {
  for (const permissionMode of ['auto', 'acceptEdits']) {
    const list = rules({ permissionMode, tools: [] });
    assert.ok(has(list, 'fs_write', 'allow', folders), permissionMode);
    assert.ok(has(list, 'fs_write', 'deny', guarded), `${permissionMode}: .kiro and .git denied`);
  }
});

test('#136 Ask me gets none of it, and Accept edits gets no command, web or MCP allow', () => {
  const ask = rules({ permissionMode: 'ask', tools: ['shell', 'web.fetch'], canPublish: true });
  assert.ok(!ask.some((r) => r.capability === 'fs_write'), 'no edits in Ask me');
  for (const c of ['shell', 'web_fetch', 'web_search']) assert.ok(!has(ask, c, 'allow'), c);
  assert.ok(!has(ask, 'mcp', 'allow', ['*/*']));
  const edits = rules({ permissionMode: 'acceptEdits', tools: ['shell', 'web.fetch'], canPublish: true });
  for (const c of ['shell', 'web_fetch', 'web_search']) assert.ok(!has(edits, c, 'allow'), c);
  assert.ok(!has(edits, 'mcp', 'allow', ['*/*']));
});

// #1723, as #1710 for Antigravity: in Auto with Shell, any command runs, so Kiro’s file tools follow the shell’s rule.
// Kiro can’t ask, so a refused read or edit only sent the agent to the shell. Kiro’s own config stays off-limits to
// edits: each working folder’s .kiro and the Kiro home the turn runs with, whose settings start MCP servers.
test('#1723 in Auto with Shell, reads and edits are allowed anywhere, without Postbox’s .git deny, but not Kiro’s own config', () => {
  const kiroHome = '/nowhere/kiro-home';
  const auto = kiroRules({ persona: { permissionMode: 'auto', tools: ['shell'] }, folders, resolve: false, kiroHome });
  // `**`: for file tools Kiro reads `*` within one path segment (kiro.dev/docs/permissions).
  assert.ok(has(auto, 'fs_read', 'allow', ['**']), 'reads anywhere');
  assert.ok(has(auto, 'fs_write', 'allow', ['**']), 'edits anywhere');
  assert.ok(
    has(
      auto,
      'fs_write',
      'deny',
      folders.map((d) => `${d}/.kiro`),
    ),
    'each folder’s .kiro stays denied',
  );
  assert.ok(!auto.some((r) => r.effect === 'deny' && r.match.some((m) => m.endsWith('/.git'))), '.git is no longer denied');
  assert.ok(has(auto, 'fs_write', 'deny', [kiroHome]), 'the Kiro home stays denied');
});

test('#1723 without Shell, or in Accept edits, the file tools keep their folders, with .kiro and .git denied', () => {
  for (const persona of [
    { permissionMode: 'auto', tools: [] },
    { permissionMode: 'acceptEdits', tools: ['shell'] },
  ]) {
    const list = kiroRules({ persona, folders, resolve: false, kiroHome: '/nowhere/kiro-home' });
    assert.ok(!has(list, 'fs_read', 'allow', ['**']) && !has(list, 'fs_write', 'allow', ['**']), JSON.stringify(persona));
    assert.ok(has(list, 'fs_write', 'deny', guarded), JSON.stringify(persona));
  }
});

test('#1723 on a host, the Kiro home kept from edits is Postbox’s own for an Isolated agent, else ~/.kiro', async () => {
  const { remoteKiroHome } = await import('../server/adapters/kiro-cli-remote.mjs');
  assert.equal(remoteKiroHome({ handle: 'kay', usesHostSetup: false }, '/srv/hostuser'), '/srv/hostuser/.postbox-remote/kiro-home/kay');
  assert.equal(remoteKiroHome({ handle: 'kay', usesHostSetup: true }, '/srv/hostuser'), '/srv/hostuser/.kiro');
  assert.equal(remoteKiroHome({ handle: 'kay' }, undefined), null);
});

// The deny has to reach the agent file each turn runs with, here and on a host, and name the home as Kiro resolves it:
// a Kiro home that is a link (a dotfiles folder, /tmp on macOS) is matched by its target.
test('#1723 the turn’s agent file denies edits of its Kiro home, as given and as resolved, here and on a host', async () => {
  const { mkdirSync, realpathSync, symlinkSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { KiroCliAdapter } = await import('../server/adapters/kiro-cli.mjs');
  const { fakeCtx, fakeSpawn, fixture } = await import('./kiro-cli-fakes.mjs');
  const { HOME, play, setup, startOf } = await import('./kiro-cli-remote-fixture.mjs');
  const { tempDir } = await import('./temp-dirs.mjs');
  const persona = { permissionMode: 'auto', tools: ['shell'] };
  const homeDeny = (file) => file.permissions.rules.find((r) => r.capability === 'fs_write' && r.effect === 'deny' && !r.match[0].endsWith('/.kiro'))?.match;

  const root = tempDir('pb-kiro-home-');
  mkdirSync(join(root, 'real-home'));
  symlinkSync(join(root, 'real-home'), join(root, 'home'));
  const seen = [];
  const spawnImpl = /** @type {any} */ (fakeSpawn([{ lines: fixture('first'), code: 0 }], seen));
  const ctx = fakeCtx();
  Object.assign(ctx.persona, persona);
  const adapter = new KiroCliAdapter({ workRoot: join(root, 'work'), isolatedHome: join(root, 'home'), spawnImpl, env: {} });
  await adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  assert.deepEqual(homeDeny(seen[0].agentFile), [join(root, 'home'), realpathSync.native(join(root, 'real-home'))]);

  const remote = await setup({ persona });
  const turn = remote.adapter.deliver({}, { kind: 'user', text: 'hi' }, remote.ctx);
  const start = await startOf(remote.d);
  play(remote.d, start, 'first');
  await turn;
  assert.deepEqual(homeDeny(JSON.parse(start.agentFile.text)), [`${HOME}/.postbox-remote/kiro-home/kiro`]);
});
