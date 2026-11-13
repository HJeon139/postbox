// #208, decided 27 October 2026: a persona’s memory is deleted with the persona, as its sessions are; a new persona
// with the same name starts clean. Delete is just delete, at once, with no Undo window to hold anything for. The memory files
// here stand in for what Claude Code writes in a persona’s folder: the real two-agent run on 28 October saw it write
// MEMORY.md and project-codeword.md in <data>/memory/<persona id>/<project id>/ (tests/memory-per-persona.test.mjs).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { memoryRootFor } from '../server/adapters/folder.mjs';
import { memoryFolder } from '../server/adapters/setup.mjs';
import { deletePersona } from '../server/persona-delete.mjs';
import { Runtime } from '../server/runtime.mjs';
import { sessionRoute } from '../server/session-routes.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

/** Waits for check() to hold, looking every 10 ms within ms, and once more at the deadline, so a stall past it still sees the change. */
async function until(check, what, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (check()) return;
  assert.ok(check(), `Timed out waiting for ${what}.`);
}

async function setup() {
  const data = tempDir('pb-persona-delete-');
  const workRoot = join(data, 'workspaces');
  const store = new Store(null);
  const adapters = new AdapterRegistry().register(new ClaudeCodeAdapter({ bin: 'claude', workRoot }));
  const rt = new Runtime({ store, adapters, config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 } });
  const project = { id: 'p1', name: 'P', folder: data };
  store.emit('project', project);
  const alpha = rt.createPersona({ handle: 'alpha', backend: 'claude-code' });
  const beta = rt.createPersona({ handle: 'beta', backend: 'claude-code' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [alpha.id, beta.id] });
  // What Claude Code wrote for each, in its own folder.
  const remember = async (p) => {
    const dir = memoryFolder(memoryRootFor(workRoot), p, project);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'MEMORY.md'), `- [Codeword](codeword.md) — @${p.handle}’s codeword\n`);
    return dir;
  };
  return { data, workRoot, store, rt, project, alpha, beta, t, remember };
}

test('#208: deleting a persona takes it, its sessions and its own memory at once, and nobody else’s', async () => {
  const s = await setup();
  await s.remember(s.alpha);
  const betaDir = await s.remember(s.beta);
  const own = Object.values(s.store.state.sessions).filter((se) => se.personaId === s.alpha.id);
  assert.ok(own.length);
  const r = await sessionRoute(s.rt, `/api/personas/${s.alpha.id}`, 'DELETE', {});
  assert.deepEqual(r, { status: 200, body: { handle: 'alpha' } });
  assert.equal(s.store.state.personas[s.alpha.id], undefined, 'the persona is gone at once');
  assert.ok(
    own.every((se) => !s.store.state.sessions[se.id]),
    'its sessions are gone at once',
  );
  assert.equal(s.rt.personaByHandle('alpha'), undefined, 'a mention no longer reaches it');
  assert.ok(
    s.rt.sessionsIn(s.t.id).some((se) => se.personaId === s.beta.id),
    'the room keeps its other agent',
  );
  // Its memory goes as each backend forgets it, just after. The route doesn’t hand back that promise, so this waits
  // for the persona’s whole memory folder, not the folder remember() wrote inside it: a recursive rm takes that first.
  const alphaMemory = join(memoryRootFor(s.workRoot), s.alpha.id);
  await until(() => !existsSync(alphaMemory), 'its memory to go');
  assert.ok(existsSync(join(betaDir, 'MEMORY.md')), 'another persona’s memory stays');
  // The name is free at once, and a new persona with it starts clean: memory is kept by id.
  const again = s.rt.createPersona({ handle: 'alpha', backend: 'claude-code' });
  assert.notEqual(again.id, s.alpha.id);
  assert.equal(existsSync(memoryFolder(memoryRootFor(s.workRoot), again, s.project)), false);
});

test('#208: the delete’s answer waits for no backend: a slow forget runs after the persona is gone', async () => {
  const s = await setup();
  /** @type {(v?: unknown) => void} */
  let entered = () => {};
  const reached = new Promise((r) => (entered = r));
  const slow = { name: 'slow', deliver: async () => {}, forget: () => new Promise((r) => entered(r)) };
  s.rt.adapters.register(slow);
  const { forgotten } = deletePersona(s.rt, s.alpha.id);
  assert.equal(s.store.state.personas[s.alpha.id], undefined, 'gone before any backend forgets it');
  const release = /** @type {(v?: unknown) => void} */ (await reached);
  release();
  await forgotten;
});

test('#208: deleting a persona that doesn’t exist says so', () => {
  const s = setup();
  return s.then((x) =>
    assert.throws(
      () => deletePersona(x.rt, 'nope'),
      (e) => e.status === 404,
    ),
  );
});
