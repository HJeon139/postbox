// A Codex agent's folder reached through a symlink: Codex refuses a writable root with a symlink in its path
// ("symlinked writable roots are not supported"), so in Auto every command failed before it started. Apart from
// tests/codex.test.mjs, which is at its length ceiling.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { fakeAppServer } from './codex-fixture.mjs';

test('a project folder reached through a symlink goes to Codex by its real path: the app-server’s cwd, the thread and the writable root', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-codex-real-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'home', 'research'), { recursive: true });
  await symlink(join(root, 'home'), join(root, 'data'));
  const seen = [];
  /** @type {any} */
  let spawnedIn = null;
  const adapter = new CodexAdapter({
    workRoot: join(root, 'work'),
    spawnImpl: (_bin, _args, opts) => {
      spawnedIn = opts?.cwd;
      return fakeAppServer(seen);
    },
  });
  const ctx = {
    persona: { handle: 'gpt', model: 'gpt-5.6-terra', effort: 'medium', permissionMode: 'auto' },
    project: { folder: join(root, 'data', 'research') },
    handles: ['gpt'],
    state: {},
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=s1',
    text: () => {},
    activity: () => {},
    status: () => {},
    saveState: () => {},
    checkpoint: () => {},
    pathOf: () => null,
  };
  await adapter.deliver({}, { kind: 'user', text: 'Say hello.' }, ctx);
  const real = join(root, 'home', 'research');
  assert.equal(spawnedIn, real);
  assert.equal(seen.find((x) => x.method === 'thread/start').params.cwd, real);
  const turn = seen.find((x) => x.method === 'turn/start').params;
  assert.equal(turn.cwd, real);
  assert.deepEqual(turn.sandboxPolicy.writableRoots, [real]);
});
