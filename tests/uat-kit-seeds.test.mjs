// The Loop study kit's two scenario lines that v4.0.7 dropped: `- seed: dir:<path>` copies a project folder into the
// workspace, and `- personas: <file>` seeds the agents from that file instead of tests/uat/e2e/personas.json. Without
// them an sf-evalgen-wf1 run started with an empty workspace and a `builder` with no tools (11/12 00:43).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { seedAgents } from '../tools/uat/seed.mjs';
import { seedDir } from '../tools/uat/workspace.mjs';

const ROOT = join(import.meta.dirname, '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'pb-kit-seeds-'));

test('a dir: seed copies the folder, its dotfiles included, into the workspace', () => {
  const root = tmp();
  try {
    const src = join(root, 'seed');
    mkdirSync(join(src, 'claims'), { recursive: true });
    mkdirSync(join(src, '.claude'), { recursive: true });
    writeFileSync(join(src, 'claims', 'claims.jsonl'), '{"claim_id": 1}\n');
    writeFileSync(join(src, '.claude', 'settings.json'), '{"permissions": {"deny": ["Read(/x)"]}}');
    const workspace = join(root, 'ws');
    mkdirSync(workspace);
    assert.equal(parseScenario(`# T\n- seed: dir:${src}\n`).seed, `dir:${src}`);
    seedDir(workspace, src);
    assert.equal(readFileSync(join(workspace, 'claims', 'claims.jsonl'), 'utf8'), '{"claim_id": 1}\n');
    assert.deepEqual(JSON.parse(readFileSync(join(workspace, '.claude', 'settings.json'), 'utf8')).permissions, { deny: ['Read(/x)'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dir: seed that names no folder stops the run instead of starting it empty', () => {
  const root = tmp();
  try {
    const workspace = join(root, 'ws');
    mkdirSync(workspace);
    assert.throws(() => seedDir(workspace, join(root, 'missing')), /seed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// critic 11/12: Node's cpSync rewrites a relative symlink to an absolute path under the seed by default, so a builder writing
// through `.venv-skills/lib64 -> lib` (seed uc03-ondrel-rev3) would change the shared seed for the next run.
test('a dir: seed keeps a relative symlink relative, inside the workspace', () => {
  const root = tmp();
  try {
    const src = join(root, 'seed');
    mkdirSync(join(src, 'venv', 'lib'), { recursive: true });
    symlinkSync('lib', join(src, 'venv', 'lib64'));
    symlinkSync('/usr/bin/env', join(src, 'venv', 'python'));
    const workspace = join(root, 'ws');
    mkdirSync(workspace);
    seedDir(workspace, src);
    assert.equal(readlinkSync(join(workspace, 'venv', 'lib64')), 'lib');
    assert.equal(readlinkSync(join(workspace, 'venv', 'python')), '/usr/bin/env', 'a link outside the seed, such as an interpreter, stays');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dir: seed refuses a symlink that points back into the seed folder', () => {
  const root = tmp();
  try {
    const src = join(root, 'seed');
    mkdirSync(join(src, 'data'), { recursive: true });
    symlinkSync(join(src, 'data'), join(src, 'back'));
    const workspace = join(root, 'ws');
    mkdirSync(workspace);
    assert.throws(() => seedDir(workspace, src), /points back into the seed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a personas: file seeds the scenario’s agents from that file', async () => {
  const root = tmp();
  try {
    const file = join(root, 'personas.json');
    writeFileSync(file, JSON.stringify([{ handle: 'builder', description: 'Builds it.', tools: ['shell', 'web.fetch'] }]));
    const data = join(root, 'data');
    mkdirSync(data);
    const scenario = parseScenario(`# T\n- agents: builder\n- personas: ${file}\n`);
    assert.equal(scenario.personas, file);
    await seedAgents({ scenario, opt: { 'agent-model': 'claude-haiku-5-5', 'agent-effort': 'low' }, root: ROOT, data, log: () => {} });
    const builder = JSON.parse(readFileSync(join(data, 'agents.json'), 'utf8')).find((p) => p.handle === 'builder');
    assert.deepEqual(builder.tools, ['shell', 'web.fetch']);
    assert.equal(builder.description, 'Builds it.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without a personas: line, the agents still come from tests/uat/e2e/personas.json', () => {
  assert.equal(parseScenario('# T\n- agents: researcher\n').personas, null);
});
