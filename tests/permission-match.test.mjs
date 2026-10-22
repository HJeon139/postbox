// #66: the permissions panel’s effective view. Which rule decides a call, in Claude Code’s order, for the rule
// forms Claude Code documents.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, parseCall, parseRule, ruleMatches, splitCommand } from '../shared/permission-match.mjs';

const where = { cwd: '/work/site', home: '/home/me' };
const m = (rule, call) => ruleMatches(rule, parseCall(call), where);
const rules = (o) => ({
  deny: (o.deny ?? []).map((rule) => ({ rule, source: 'local' })),
  ask: (o.ask ?? []).map((rule) => ({ rule, source: 'local' })),
  allow: (o.allow ?? []).map((rule) => ({ rule, source: 'local' })),
});

test('rules and calls parse into a tool and what they cover', () => {
  assert.deepEqual(parseRule('Bash(npm test:*)'), { tool: 'Bash', spec: 'npm test:*' });
  assert.deepEqual(parseRule('Bash'), { tool: 'Bash', spec: null });
  assert.deepEqual(parseRule('Bash(*)'), { tool: 'Bash', spec: null });
  assert.deepEqual(parseCall('WebFetch(https://example.com/x)'), { tool: 'WebFetch', arg: 'https://example.com/x' });
  assert.deepEqual(parseCall('mcp__github__create_issue'), { tool: 'mcp__github__create_issue', arg: null });
});

test('Bash rules: exact, a prefix with :*, and globs where a space before * needs a word break', () => {
  assert.ok(m('Bash', 'Bash(rm -rf build)'));
  assert.ok(m('Bash(npm run build)', 'Bash(npm run build)'));
  assert.ok(!m('Bash(npm run build)', 'Bash(npm run build --prod)'));
  assert.ok(m('Bash(npm test:*)', 'Bash(npm test)'));
  assert.ok(m('Bash(npm test:*)', 'Bash(npm test -- --watch)'));
  assert.ok(!m('Bash(npm test:*)', 'Bash(npm testing)'));
  assert.ok(m('Bash(git * main)', 'Bash(git push origin main)'));
  assert.ok(!m('Bash(git * main)', 'Bash(git push origin dev)'));
  assert.ok(m('Bash(ls *)', 'Bash(ls -la)'));
  assert.ok(m('Bash(ls *)', 'Bash(ls)'));
  assert.ok(!m('Bash(ls *)', 'Bash(lsof)'));
  assert.ok(m('Bash(ls*)', 'Bash(lsof)'));
});

test('a command that chains is split outside quotes', () => {
  assert.deepEqual(splitCommand('npm test && rm -rf x; echo "a && b" | wc -l'), ['npm test', 'rm -rf x', 'echo "a && b"', 'wc -l']);
  // An allow rule has to cover every part; a deny rule on any part decides.
  assert.equal(decide({ call: 'Bash(npm test && rm -rf x)', rules: rules({ allow: ['Bash(npm test:*)'] }), mode: 'ask', ...where }).decision, 'mode');
  const d = decide({ call: 'Bash(npm test && rm -rf x)', rules: rules({ allow: ['Bash(npm test:*)'], deny: ['Bash(rm:*)'] }), mode: 'ask', ...where });
  assert.deepEqual([d.decision, d.rule, d.part], ['deny', 'Bash(rm:*)', 'rm -rf x']);
  assert.equal(decide({ call: 'Bash(npm test && npm run lint)', rules: rules({ allow: ['Bash(npm:*)'] }), mode: 'ask', ...where }).decision, 'allow');
});

test('WebFetch rules match a domain, or its subdomains with *.', () => {
  assert.ok(m('WebFetch(domain:example.com)', 'WebFetch(https://example.com/x)'));
  assert.ok(!m('WebFetch(domain:example.com)', 'WebFetch(https://docs.example.com/x)'));
  assert.ok(m('WebFetch(domain:*.example.com)', 'WebFetch(https://docs.example.com/x)'));
  assert.ok(!m('WebFetch(domain:example.com)', 'WebFetch(https://example.org/)'));
});

test('Read and Edit rules are gitignore-style paths, from the working folder, the settings folder, home or the root', () => {
  assert.ok(m('Read(./src/**)', 'Read(src/a/b.js)'));
  assert.ok(m('Read(src/**)', 'Read(/work/site/src/a.js)'));
  assert.ok(!m('Read(src/*)', 'Read(src/a/b.js)'));
  assert.ok(m('Read(src/*)', 'Read(src/b.js)'));
  assert.ok(m('Read(~/.zshrc)', 'Read(/home/me/.zshrc)'));
  assert.ok(m('Read(//tmp/x.txt)', 'Read(/tmp/x.txt)'));
  assert.ok(m('Read(*.env)', 'Read(config/prod.env)'));
  assert.ok(!m('Read(*.env)', 'Read(config/prod.envy)'));
  // /path starts at the settings file’s folder (the root), not where the agent works.
  assert.ok(ruleMatches('Edit(/docs/**)', parseCall('Edit(/repo/docs/a.md)'), { ...where, root: '/repo' }));
  assert.ok(!ruleMatches('Edit(/docs/**)', parseCall('Edit(/work/site/docs/a.md)'), { ...where, root: '/repo' }));
  // An Edit rule covers every tool that changes files, and a Read rule every tool that reads them.
  assert.ok(m('Edit(docs/**)', 'Write(docs/new.md)'));
  assert.ok(m('Read(docs/**)', 'Grep(docs/a)'));
  assert.ok(!m('Read(docs/**)', 'Write(docs/new.md)'));
});

test('MCP rules match a whole server or one tool; tool-name globs match too', () => {
  assert.ok(m('mcp__github', 'mcp__github__create_issue'));
  assert.ok(m('mcp__github__*', 'mcp__github__create_issue'));
  assert.ok(m('mcp__github__create_issue', 'mcp__github__create_issue'));
  assert.ok(!m('mcp__github__create_issue', 'mcp__github__list_issues'));
  assert.ok(!m('mcp__git', 'mcp__github__create_issue'));
  assert.ok(m('mcp__*__send_*', 'mcp__slack__send_message'));
  assert.ok(m('Agent(Explore)', 'Agent(Explore)'));
  assert.ok(!m('Agent(Explore)', 'Agent(Plan)'));
});

test('deny wins over ask, ask over allow, and the mode decides what no rule covers', () => {
  const all = rules({ deny: ['Bash(rm:*)'], ask: ['Bash(git push:*)'], allow: ['Bash', 'Bash(git push:*)'] });
  assert.equal(decide({ call: 'Bash(rm -rf x)', rules: all, mode: 'bypass', ...where }).outcome, 'refused');
  assert.equal(decide({ call: 'Bash(git push origin main)', rules: all, mode: 'ask', ...where }).decision, 'ask');
  assert.equal(decide({ call: 'Bash(ls)', rules: all, mode: 'ask', ...where }).decision, 'allow');
  const none = rules({});
  assert.equal(decide({ call: 'Bash(ls)', rules: none, mode: 'ask', ...where }).outcome, 'asks');
  assert.equal(decide({ call: 'Read(a.txt)', rules: none, mode: 'ask', ...where }).outcome, 'runs');
  assert.equal(decide({ call: 'Edit(a.txt)', rules: none, mode: 'acceptEdits', ...where }).outcome, 'runs');
  assert.equal(decide({ call: 'Bash(ls)', rules: none, mode: 'acceptEdits', ...where }).outcome, 'asks');
  assert.equal(decide({ call: 'Bash(ls)', rules: none, mode: 'auto', ...where }).outcome, 'decides');
  assert.equal(decide({ call: 'Bash(ls)', rules: none, mode: 'bypass', ...where }).outcome, 'runs');
});
