// #208, decided 27 October 2026: a persona’s memory is deleted with the persona, once the delete’s Undo window has
// passed, as its sessions are; Undo brings both back; a new persona with the same name starts clean. The memory files
// here stand in for what Claude Code writes in a persona’s folder: the real two-agent run on 28 October saw it write
// MEMORY.md and project-codeword.md in <data>/memory/<persona id>/<project id>/ (tests/memory-per-persona.test.mjs).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { memoryRootFor } from '../server/adapters/folder.mjs';
import { memoryFolder } from '../server/adapters/setup.mjs';
import { deletePersona, purgePersona, rearmPersonaDeletes } from '../server/persona-delete.mjs';
import { Runtime } from '../server/runtime.mjs';
import { sessionRoute } from '../server/session-routes.mjs';
import { Store } from '../server/store.mjs';

async function setup() {
  const data = await mkdtemp(join(tmpdir(), 'pb-persona-delete-'));
  const workRoot = join(data, 'workspaces');
  const store = new Store(null);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const adapters = new AdapterRegistry().register(new ClaudeCodeAdapter({ bin: 'claude', workRoot }));
  const rt = new Runtime({ store, adapters, corpus, config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 } });
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
  return { data, workRoot, store, rt, project, alpha, beta, t, remember, done: () => rm(data, { recursive: true, force: true }) };
}

test('#208: deleting a persona takes its sessions and, after the Undo window, its own memory, and nobody else’s', async () => {
  const s = await setup();
  try {
    const alphaDir = await s.remember(s.alpha);
    const betaDir = await s.remember(s.beta);
    const r = await sessionRoute(s.rt, `/api/personas/${s.alpha.id}`, 'DELETE', {});
    assert.equal(r?.status, 200);
    assert.ok(r.body.until > Date.now());
    assert.equal(r.body.handle, 'alpha');
    const own = Object.values(s.store.state.sessions).filter((se) => se.personaId === s.alpha.id);
    assert.ok(own.length && own.every((se) => se.deleting), 'its sessions are being deleted with it');
    assert.equal(s.rt.personaByHandle('alpha'), undefined, 'a mention no longer reaches it');
    assert.ok(existsSync(alphaDir), 'its memory stays through the Undo window');
    await purgePersona(s.rt, s.alpha.id);
    assert.equal(s.store.state.personas[s.alpha.id], undefined);
    assert.ok(
      own.every((se) => !s.store.state.sessions[se.id]),
      'its sessions are gone',
    );
    assert.equal(existsSync(join(memoryRootFor(s.workRoot), s.alpha.id)), false, 'its memory is gone');
    assert.ok(existsSync(join(betaDir, 'MEMORY.md')), 'another persona’s memory stays');
    // A new persona with the same name starts clean: memory is kept by id.
    const again = s.rt.createPersona({ handle: 'alpha', backend: 'claude-code' });
    assert.notEqual(again.id, s.alpha.id);
    assert.equal(existsSync(memoryFolder(memoryRootFor(s.workRoot), again, s.project)), false);
  } finally {
    await s.done();
  }
});

test('#208: Undo keeps the persona, the sessions its delete took, and its memory', async () => {
  const s = await setup();
  try {
    const alphaDir = await s.remember(s.alpha);
    // One session deleted on its own before stays deleted after Undo.
    const other = s.rt.createThread({ projectId: 'p1', title: 'U', personaIds: [s.alpha.id] });
    const before = s.rt.sessionsIn(other.id)[0];
    s.rt.deleteSession(before.id);
    await sessionRoute(s.rt, `/api/personas/${s.alpha.id}`, 'DELETE', {});
    const r = await sessionRoute(s.rt, `/api/personas/${s.alpha.id}/undo-delete`, 'POST', {});
    assert.equal(r?.status, 200);
    const p = s.store.state.personas[s.alpha.id];
    assert.ok(p && !p.deleting && !p.deletingSessions);
    assert.equal(s.rt.personaByHandle('alpha')?.id, s.alpha.id);
    const kept = s.rt.sessionsIn(s.t.id).find((se) => se.personaId === s.alpha.id);
    assert.ok(kept && !kept.deleting, 'the session its delete took is back');
    assert.ok(s.store.state.sessions[before.id].deleting, 'one deleted on its own isn’t brought back');
    // The window’s timer, had it fired late, does nothing now.
    await purgePersona(s.rt, s.alpha.id);
    assert.ok(s.store.state.personas[s.alpha.id]);
    assert.ok(existsSync(join(alphaDir, 'MEMORY.md')), 'its memory is kept');
    await assert.rejects(sessionRoute(s.rt, `/api/personas/${s.alpha.id}/undo-delete`, 'POST', {}), (e) => e.status === 409);
  } finally {
    await s.done();
  }
});

test('#208: a delete still pending when Postbox stopped finishes after a restart, and its name stays taken until then', async () => {
  const s = await setup();
  try {
    await s.remember(s.alpha);
    await sessionRoute(s.rt, `/api/personas/${s.alpha.id}`, 'DELETE', {});
    // The name is held while it can still be undone, so Undo can never make two agents with one name.
    assert.throws(
      () => s.rt.createPersona({ handle: 'alpha', backend: 'claude-code' }),
      (e) => e.status === 409 && /being deleted/.test(e.message),
    );
    // A restart: the stored state survives, the timer doesn’t. The window has passed by the time Postbox is back.
    const rt = new Runtime({ store: s.store, adapters: s.rt.adapters, corpus: s.rt.corpus, config: s.rt.config });
    s.store.emit('persona', { ...s.store.state.personas[s.alpha.id], deleting: Date.now() - 1 });
    rearmPersonaDeletes(rt);
    // Removed last, after its memory (purgePersona), so this waits for the whole delete, however busy the machine.
    for (let i = 0; i < 500 && s.store.state.personas[s.alpha.id]; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.store.state.personas[s.alpha.id], undefined, 'it finished');
    assert.equal(existsSync(join(memoryRootFor(s.workRoot), s.alpha.id)), false, 'its memory is gone');
    assert.ok(rt.createPersona({ handle: 'alpha', backend: 'claude-code' }), 'the name is free again');
  } finally {
    await s.done();
  }
});

test('#208: attaching a terminal session names around a persona still being deleted', async () => {
  const s = await setup();
  try {
    // A Claude Code session in /work/site, as tests/claude-code.test.mjs’s attachSetup writes one.
    const id = '11111111-2222-3333-4444-555555555555';
    await mkdir(join(s.data, 'projects', '-work-site'), { recursive: true });
    const line = (o) => `${JSON.stringify({ sessionId: id, cwd: '/work/site', timestamp: new Date().toISOString(), ...o })}\n`;
    await writeFile(
      join(s.data, 'projects', '-work-site', `${id}.jsonl`),
      line({ type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'Fix the header' } }) +
        line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }], stop_reason: 'end_turn' } }),
    );
    const rt = new Runtime({
      store: s.store,
      adapters: s.rt.adapters,
      corpus: s.rt.corpus,
      config: { ...s.rt.config, claudeProjectsRoot: join(s.data, 'projects') },
    });
    const old = rt.createPersona({ handle: 'site', backend: 'claude-code' });
    deletePersona(rt, old.id);
    const { personaId } = await rt.attachClaudeSession({ claudeSessionId: id, projectId: 'p1' });
    rt.stopMirrors();
    assert.equal(s.store.state.personas[personaId].handle, 'site-2', 'it moves on to the next name, as for a taken one');
  } finally {
    await s.done();
  }
});

test('#208: an agent being deleted can’t be added to a conversation, and the purge takes every session it has', async () => {
  const s = await setup();
  try {
    await sessionRoute(s.rt, `/api/personas/${s.alpha.id}`, 'DELETE', {});
    // From another tab, an old picker, or the API: refused while the delete can still be undone.
    assert.throws(
      () => s.rt.createThread({ projectId: 'p1', title: 'Late', personaIds: [s.alpha.id] }),
      (e) => e.status === 409 && /being deleted/.test(e.message),
    );
    const room = s.rt.createThread({ projectId: 'p1', title: 'Room', personaIds: [s.beta.id] });
    assert.throws(
      () => s.rt.ensureSession(room.id, s.alpha.id),
      (e) => e.status === 409,
    );
    // A session it had that this delete didn’t take (deleted on its own before, or restored) goes too.
    const stray = s.rt.putSession({
      ...Object.values(s.store.state.sessions).find((se) => se.personaId === s.alpha.id),
      id: 'se_stray',
      threadId: room.id,
      deleting: null,
    });
    await purgePersona(s.rt, s.alpha.id);
    assert.equal(s.store.state.sessions[stray.id], undefined, 'no session is left with no persona');
    assert.deepEqual(
      Object.values(s.store.state.sessions).filter((se) => se.personaId === s.alpha.id),
      [],
    );
  } finally {
    await s.done();
  }
});

test('#208: Undo during the purge says it’s too late, and the persona isn’t brought back half-gone', async () => {
  const s = await setup();
  try {
    let release = () => {};
    const slow = { name: 'slow', deliver: async () => {}, forget: () => new Promise((r) => (release = r)) };
    s.rt.adapters.register(slow);
    await sessionRoute(s.rt, `/api/personas/${s.alpha.id}`, 'DELETE', {});
    const purging = purgePersona(s.rt, s.alpha.id);
    await new Promise((r) => setTimeout(r, 10));
    // The purge waits on a backend’s forget: Undo now must not answer 200 and then lose.
    await assert.rejects(sessionRoute(s.rt, `/api/personas/${s.alpha.id}/undo-delete`, 'POST', {}), (e) => e.status === 409 && /too late/.test(e.message));
    release();
    await purging;
    assert.equal(s.store.state.personas[s.alpha.id], undefined);
  } finally {
    await s.done();
  }
});

test('#208: a purge a restart cut short finishes when Postbox starts again', async () => {
  const s = await setup();
  try {
    await s.remember(s.alpha);
    await sessionRoute(s.rt, `/api/personas/${s.alpha.id}`, 'DELETE', {});
    // Saved mid-purge: it had started (purging), its window long over, and it never removed the persona.
    s.store.emit('persona', { ...s.store.state.personas[s.alpha.id], deleting: Date.now() - 1, purging: true });
    const rt = new Runtime({ store: s.store, adapters: s.rt.adapters, corpus: s.rt.corpus, config: s.rt.config });
    rearmPersonaDeletes(rt);
    for (let i = 0; i < 500 && s.store.state.personas[s.alpha.id]; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.store.state.personas[s.alpha.id], undefined, 'it finished');
    assert.equal(existsSync(join(memoryRootFor(s.workRoot), s.alpha.id)), false, 'its memory is gone');
  } finally {
    await s.done();
  }
});
