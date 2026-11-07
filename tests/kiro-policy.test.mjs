// A study’s deny rules for every Kiro turn (POSTBOX_KIRO_POLICY, server/adapters/setup.mjs kiroPolicyRules).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { kiroAgent } from '../server/adapters/kiro-cli.mjs';
import { kiroPolicyRules } from '../server/adapters/setup.mjs';

const deny = { capability: 'shell', match: ['*aws cloudtrail*', '*aws configure export-credentials*'], effect: 'deny' };
const policyFile = (rules) => {
  const file = join(mkdtempSync(join(tmpdir(), 'kiro-policy-')), 'policy.json');
  writeFileSync(file, typeof rules === 'string' ? rules : JSON.stringify(rules));
  return file;
};

test('the policy file’s denies reach the agent file of every turn', () => {
  const file = policyFile([deny]);
  assert.deepEqual(kiroPolicyRules(file), [deny]);
  assert.deepEqual(kiroPolicyRules(''), []);
  const before = process.env.POSTBOX_KIRO_POLICY;
  process.env.POSTBOX_KIRO_POLICY = file;
  try {
    const agent = kiroAgent({
      name: 't',
      persona: { handle: 'builder', tools: ['shell'], usesHostSetup: false },
      mcpUrl: 'http://127.0.0.1:1/mcp',
      guide: '',
      folders: ['/nowhere'],
    });
    assert.deepEqual(agent.permissions.rules.at(-1), deny);
  } finally {
    if (before === undefined) delete process.env.POSTBOX_KIRO_POLICY;
    else process.env.POSTBOX_KIRO_POLICY = before;
  }
});

test('a policy that would widen a persona, or doesn’t parse, stops the turn rather than being dropped', () => {
  assert.throws(() => kiroPolicyRules(policyFile([{ capability: 'shell', match: ['*'], effect: 'allow' }])), /array of deny rules/);
  assert.throws(() => kiroPolicyRules(policyFile([{ capability: 'shell', effect: 'deny' }])), /array of deny rules/);
  assert.throws(() => kiroPolicyRules(policyFile('not json')), /Couldn’t read the Kiro policy/);
});
