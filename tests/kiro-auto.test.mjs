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
