// #585: what the conformance probe reads of `agy plugin validate --json`. The fixtures are agy 1.5.18’s output, with
// the probe’s temp HOME taken out of its paths, which leaves /work/plugin: plugin-validate.json for the plugin
// Postbox’s writers made, and plugin-validate-broken.json for the same plugin after its plugin.json was cut off
// partway by hand, which agy exits 1 on.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AGY_RULES_LIMIT } from '../server/adapters/agy-plugin.mjs';
import { parseValidate, rulesHold, validated } from '../tools/conformance/agy.mjs';

const fixture = (name) => readFileSync(new URL(`fixtures/antigravity-cli/${name}`, import.meta.url), 'utf8');

test('agy’s validation of Postbox’s plugin counts one rules file and no error, its warnings aside', () => {
  assert.deepEqual(parseValidate(fixture('plugin-validate.json')), { readable: true, rules: 1, errors: [] });
});

test('a plugin agy skips has no rules and its error findings', () => {
  assert.deepEqual(parseValidate(fixture('plugin-validate-broken.json')), {
    readable: true,
    rules: 0,
    errors: ['plugin.json: unexpected EOF. The loader skips this plugin'],
  });
});

test('output that isn’t JSON can’t pass', () => {
  const said = parseValidate('Error: validation failed');
  assert.equal(said.readable, false);
  assert.equal(said.rules, 0);
  assert.equal(said.errors.length, 1);
});

test('the check passes only an exit of 0 with exactly one rules file and no error', () => {
  const said = parseValidate(fixture('plugin-validate.json'));
  assert.equal(validated({ code: 0 }, said), true);
  assert.equal(validated({ code: 1 }, said), false, 'agy exited 1');
  assert.equal(validated({ code: null }, said), false, 'agy didn’t run or timed out');
  assert.equal(validated({ code: 0 }, { ...said, rules: 0 }), false, 'no rules file counted');
  assert.equal(validated({ code: 0 }, { ...said, rules: 2 }), false, 'a second rules file');
  assert.equal(validated({ code: 0 }, { ...said, errors: ['rules/AGENTS.md: too long'] }), false, 'an error finding');
  assert.equal(validated({ code: 0 }, parseValidate('not JSON')), false, 'output it couldn’t read');
});

test('the rules precondition needs the whole guide and agy’s limit, each on its own', () => {
  const guide = 'guide postbox-conformance-agy-0';
  assert.equal(rulesHold(`rules\n${guide}\n`, guide), true);
  assert.equal(rulesHold(`rules\n${guide.slice(0, -1)}\n`, guide), false, 'the guide cut short');
  assert.equal(rulesHold(`${guide}${'x'.repeat(AGY_RULES_LIMIT)}`, guide), false, 'over agy’s limit');
  assert.equal(rulesHold(`${guide}${'x'.repeat(AGY_RULES_LIMIT - guide.length)}`, guide), true, 'exactly at the limit');
});
