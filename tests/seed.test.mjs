import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { deniedTools, OUTSIDE_TOOLS } from '../server/adapters/setup.mjs';
import { Runtime } from '../server/runtime.mjs';
import { DEMO_PERSONAS, freshInstall, seed } from '../server/seed.mjs';
import { Store } from '../server/store.mjs';

async function seeded({ demo = false, agents = null } = {}) {
  const store = new Store(null);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  // Seeding only checks that the agents' backend exists.
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({ name: 'claude-code' }),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [] },
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-seed-'));
  if (agents) await writeFile(join(dataDir, 'agents.json'), JSON.stringify(agents));
  await seed(rt, { dataDir, booksDir: join(dataDir, 'books'), backend: 'claude-code', demo });
  const s = store.state;
  return {
    agents: Object.values(s.personas).map((p) => `@${p.handle} on ${p.backend}`),
    projects: Object.values(s.projects).map((p) => p.name),
    threads: Object.values(s.threads).length,
  };
}

test('a fresh install seeds one generic agent, and no projects or conversations', async () => {
  const fresh = freshInstall();
  assert.deepEqual(
    fresh.personas.map((p) => p.handle),
    ['assistant'],
  );
  assert.deepEqual(fresh.projects, []);
  assert.doesNotMatch(JSON.stringify(fresh), /corpus|book|gutenberg|index/i);
  assert.deepEqual(await seeded(), { agents: ['@assistant on claude-code'], projects: [], threads: 0 });
});

test('#5: the fresh-install agent can run commands and read the web, but not reach agents outside Postbox', () => {
  const [assistant] = freshInstall().personas;
  const denied = deniedTools({ backend: 'claude-code', ...assistant });
  for (const tool of ['Bash', 'Monitor', 'WebFetch', 'WebSearch']) assert.ok(!denied.includes(tool), `${tool} is denied`);
  for (const tool of OUTSIDE_TOOLS) assert.ok(denied.includes(tool), `${tool} isn’t denied`);
});

test('--demo seeds the book-corpus agents, their projects and conversations', async () => {
  const demo = await seeded({ demo: true });
  assert.deepEqual(
    demo.agents,
    DEMO_PERSONAS.map((p) => `@${p.handle} on claude-code`),
  );
  assert.deepEqual(demo.projects, ['Book corpus', 'Agent research']);
  assert.equal(demo.threads, 7);
});

test('agents.json in the data folder replaces the agents in either mode', async () => {
  const agents = [{ handle: 'scout', description: 'Looks around.' }];
  assert.deepEqual(await seeded({ agents }), { agents: ['@scout on claude-code'], projects: [], threads: 0 });
  // The demo's conversations need the demo's agents, so they go too.
  assert.deepEqual(await seeded({ demo: true, agents }), { agents: ['@scout on claude-code'], projects: [], threads: 0 });
});
