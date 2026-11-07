// `- files:` (tools/uat/fixtures.mjs, #206): a scenario can put the person’s own data or code in the workspace.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURES, filesOf, seedFiles } from '../tools/uat/fixtures.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';

const md = (header) => `# A scenario\n\n- persona: Someone.\n${header}\nSummary.\n\n## Phase 1: Ask\n\nAsk.\n`;

test('`- files:` names a fixture folder, and a scenario without it has none', () => {
  const [name] = readdirSync(FIXTURES);
  assert.equal(parseScenario(md(`- files: ${name}`)).files, name);
  assert.equal(parseScenario(md('')).files, null);
});

test('a fixture that doesn’t exist, or a path, is refused rather than run without its files', () => {
  assert.throws(() => filesOf('no-such-fixture'), /no “no-such-fixture”/);
  assert.throws(() => filesOf('../scenarios'), /no “\.\.\/scenarios”/);
});

test('the fixture’s contents land in the workspace, not the folder named after it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pb-fixtures-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'budget', 'data'), { recursive: true });
  writeFileSync(join(root, 'budget', 'data', 'spending.csv'), 'month,amount\n');
  const workspace = join(root, 'ws');
  mkdirSync(workspace);
  seedFiles(workspace, 'budget', root);
  assert.ok(existsSync(join(workspace, 'data', 'spending.csv')));
  assert.ok(!existsSync(join(workspace, 'budget')));
});

test('every scenario that names a fixture names one that exists', () => {
  const dir = join(import.meta.dirname, 'uat', 'e2e', 'scenarios');
  for (const f of readdirSync(dir)) {
    const line = /^- files: (.*)$/m.exec(String(readFileSync(join(dir, f))))?.[1] ?? null;
    if (line) assert.doesNotThrow(() => filesOf(line), f);
  }
});
