// What Antigravity’s rules file says about approval follows how agy runs (#370, #416). With the PreToolUse hook, a call
// agy would ask about shows the person a card, so the rules mustn’t say it’s refused: agents that read that stopped
// running commands at all. In Run everything nothing is asked; without the hook (agy before 1.4.7), headless agy refuses.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agyRules } from '../server/adapters/antigravity-cli.mjs';
import { agentGuide } from '../server/adapters/guide.mjs';

test('with the hook, the rules say calls ask through a card, and nothing says they’re refused', () => {
  for (const permissionMode of ['auto', 'ask', 'acceptEdits']) {
    const rules = agyRules({ persona: { permissionMode, tools: ['shell'] }, guide: 'G', hooked: true });
    assert.match(
      rules,
      /## Calls that need approval\n\nA command, a web search or fetch, a tool of another MCP server, or a file outside your folders may ask the person through a card in Postbox/,
    );
    assert.match(rules, /list_dir, find_by_name, grep_search and view_file need no approval/);
    assert.match(rules, /read_message \{ id \} gives one item in full: it isn’t on disk/);
    assert.doesNotMatch(rules, /Refused tool calls|is refused|Don’t use run_command/, permissionMode);
  }
});

test('without the hook, the rules keep the headless notes; in Run everything they say neither', () => {
  const old = agyRules({ persona: { permissionMode: 'auto', tools: ['shell'] }, guide: 'G', hooked: false });
  assert.match(old, /## Refused tool calls/);
  assert.match(old, /## Looking at files/);
  const all = agyRules({ persona: { permissionMode: 'bypass', tools: ['shell'] }, guide: 'G' });
  assert.doesNotMatch(all, /Refused tool calls|Calls that need approval|Looking at files/);
  assert.doesNotMatch(all, /\n\n\n/, 'no gap where a note was');
});

test('with the hook, the whole rules file still fits agy’s 12,000 characters', () => {
  const persona = { handle: 'gemini', permissionMode: 'auto', tools: [] };
  const guide = agentGuide({ persona, handles: ['gemini', 'critic'], toolRules: null, setup: false });
  assert.ok(agyRules({ persona, guide, schemas: '/Users/someone/.gemini/antigravity-cli/mcp/postbox_postbox', hooked: true }).length <= 12000);
});

// PR #1515’s review: the rules say a limit is enforced only where the hook refuses it, and keep “Antigravity can’t
// enforce that” for the rest, as for every limit before agy 1.4.7.
test('the rules say which limits the hook refuses and that Antigravity can’t enforce the rest', () => {
  const old = agyRules({ persona: { permissionMode: 'ask', tools: [] }, guide: 'G', hooked: false });
  assert.match(old, /\(agents\.outside\); publishing or posting anything outside Postbox\. Antigravity can’t enforce that, so it’s up to you: don’t do them/);
  const asks = agyRules({ persona: { permissionMode: 'auto', tools: [] }, guide: 'G', hooked: true });
  assert.match(asks, /Antigravity can’t enforce that, so it’s up to you/);
  const bypass = agyRules({ persona: { permissionMode: 'bypass', tools: [] }, guide: 'G', hooked: true });
  assert.match(
    bypass,
    /Postbox’s permission hook refuses running commands; fetching web pages or searching the web; publishing or posting anything outside Postbox\. Antigravity can’t enforce the rest, so it’s up to you: don’t do them/,
  );
  const held = agyRules({ persona: { permissionMode: 'bypass', tools: ['agents.outside'] }, guide: 'G', hooked: true });
  assert.match(held, /outside Postbox\. Postbox’s permission hook refuses them, so say so if a task needs one\./);
  assert.doesNotMatch(held, /can’t enforce/);
  // With Web on no hook runs in Run everything, so nothing is refused.
  const webOn = agyRules({ persona: { permissionMode: 'bypass', tools: ['web.fetch'] }, guide: 'G', hooked: false });
  assert.match(webOn, /Antigravity can’t enforce that/);
  assert.doesNotMatch(webOn, /permission hook refuses/);
});
