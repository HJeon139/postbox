// The agent guide (#63): what a reply contains decides its form, before anything else, and it stays short.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { agentGuide, guideText } from '../server/adapters/guide.mjs';
import { TOOL_DEFS } from '../server/mcp.mjs';
import { freshInstall } from '../server/seed.mjs';

test('the guide starts from what a reply contains, not from what the person asked for', () => {
  const g = guideText();
  const first = g.split('\n## ')[0];
  assert.match(first, /^## What your reply contains decides its form/);
  assert.match(first, /whether or not the person asked for a block/);
  for (const [contains, block] of [
    ['Options to pick from', 'a choice'],
    ['Questions for the person', 'a form'],
    ['A draft to approve', 'a review block'],
    ['A job of several steps that takes minutes', 'a progress block'],
  ])
    assert.match(first, new RegExp(`^- ${contains}[^\\n]*→ ${block}`, 'm'), `${contains} → ${block}`);
  // The old wording matched requests (“To ask for a line-by-line review…”), which agents read as “when asked”.
  assert.doesNotMatch(g, /To ask for a/);
});

test('the guide tells agents to report results, and to update an answered block only to ask again (#94)', () => {
  const g = guideText();
  assert.match(g, /Report what you did in your reply, or with update_block on the answered choice, form or confirm with outcome set/);
  assert.match(g, /Update an answered block without outcome only to ask again/);
});

test('what agents read about the app check says narrow and wide windows, not phones (#75)', () => {
  const read = [
    agentGuide({ persona: { handle: 'a' }, handles: ['a'], project: { name: 'P' }, brief: 'You were asked in.' }),
    ...TOOL_DEFS.map((t) => t.description),
    readFileSync(new URL('../app/js/apps.mjs', import.meta.url), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(read, /\bphones?\b/i);
  assert.match(read, /checks it in a narrow and a wide window \(375 and 1280 px\)/);
  assert.match(read, /This conversation belongs to the project “P”\./);
});

test('the guide stays short: agents follow defaults more than prose', () => {
  // About 8,300 characters before M1 core, which added the limits, palettes and outcome. Cut before adding.
  assert.ok(guideText().length <= 9000, `The guide is ${guideText().length} characters. Keep it under 9,000.`);
  // It’s the same text on every turn.
  const who = { persona: { handle: 'a' }, handles: ['a', 'b'] };
  assert.equal(agentGuide(who), agentGuide(who));
});

test('an agent is told which tools are turned off for it, and how to ask for one, not that the computer lacks them (#104)', () => {
  const who = { persona: { handle: 'critic', tools: ['web.fetch'] }, handles: ['critic'] };
  const g = agentGuide(who);
  assert.match(g, /## Turned off for you/);
  assert.match(g, /running commands \(shell\)/);
  assert.match(g, /messaging, scheduling or starting agents outside Postbox \(agents\.outside\)/);
  assert.doesNotMatch(g, /fetching web pages or searching the web \(web\.fetch\)/);
  assert.match(g, /don’t say the computer or the person lacks it: call ask_for_tool \{ tool: "shell"/);
  assert.ok(TOOL_DEFS.some((t) => t.name === 'ask_for_tool'));
  // Nothing off, nothing said; a backend that can’t turn tools off (Codex, agy) passes no rules.
  assert.doesNotMatch(agentGuide({ ...who, persona: { handle: 'critic', tools: ['shell', 'web.fetch', 'agents.outside'] } }), /Turned off for you/);
  assert.doesNotMatch(agentGuide({ ...who, toolRules: null }), /Turned off for you/);
  // The Kiro CLI turns off only what it has rules for.
  assert.doesNotMatch(agentGuide({ ...who, toolRules: { shell: ['shell'], 'web.fetch': ['web_fetch'] } }), /agents\.outside/);
});

test('a write outside the conversation is shown as a draft in a review block first, through any tool (#112)', () => {
  const first = guideText().split('\n## ')[0];
  assert.match(first, /^- A write outside this conversation \(a document, an issue, a message, through any tool\) → first its draft in a review block/m);
  assert.match(first, /unless they said to publish directly/);
});

test('the room tells an agent who else is in the conversation and what each does, and how to share the work', () => {
  const room = [
    { handle: 'researcher', role: 'Finds and reads sources.' },
    { handle: 'critic', role: 'Reviews code and documents.' },
  ];
  const g = agentGuide({ persona: { handle: 'developer' }, handles: ['researcher', 'developer', 'critic', 'indexer'], room });
  assert.match(g, /## In this conversation\n\n- @researcher: Finds and reads sources\.\n- @critic: Reviews code and documents\./);
  assert.match(g, /Take the part of a request that’s yours/);
  assert.match(g, /To hand work on, @mention the agent with what it needs to start/);
  // Agents elsewhere in Postbox are listed apart, without the ones already here.
  assert.match(g, /Other agents in Postbox: @indexer\./);
  // Alone in its conversation, an agent gets no team section, only who it could bring in.
  const alone = agentGuide({ persona: { handle: 'developer' }, handles: ['developer', 'critic'] });
  assert.doesNotMatch(alone, /In this conversation|Take the part/);
  assert.match(alone, /Agents in Postbox: @critic\. Mention one with @handle/);
  // The persona’s own prompt names no other agent: the team comes from the room.
  for (const p of freshInstall().personas) assert.doesNotMatch(p.instructions, /@(?:researcher|developer|critic)\b/, p.handle);
});
