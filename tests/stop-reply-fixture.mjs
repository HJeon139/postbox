// The Stop specs’ shared setup (tests/stop-reply.test.mjs, tests/stop-reply-held.test.mjs): a scripted Claude Code
// agent, a runtime around it, and a Store whose log sync can be held so emits are held behind a commit.

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { disk, handleWith } from './store-jsonl-fixture.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const folders = [];
after(() => Promise.all(folders.map((f) => rm(f, { recursive: true, force: true }))));

/** A Claude Code agent whose turn the test scripts; each step waits for Stop once it has done its part. */
export class Scripted {
  name = 'claude-code';
  constructor(folder) {
    this.folder = folder;
    this.next = null;
  }
  async folderFor() {
    return this.folder;
  }
  async deliver(_session, _message, ctx) {
    await this.next(ctx);
    if (!ctx.signal.aborted) await new Promise((r) => ctx.signal.addEventListener('abort', r, { once: true }));
  }
}

export async function setup(step, store = new Store(null)) {
  const folder = await mkdtemp(join(tmpdir(), 'pb-stop-reply-'));
  folders.push(folder);
  const adapter = new Scripted(folder);
  adapter.next = step;
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: folder },
  });
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'researcher', backend: 'claude-code', tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  return { store, rt, t, se };
}
/** Waits for a condition, never a fixed time. @param {() => boolean} pred @param {string} what */
export const until = async (pred, what) => {
  for (let i = 0; i < 400 && !pred(); i++) await sleep(5);
  assert.ok(pred(), `waited for ${what}`);
};
export const replies = (store, t, se) => store.items(t.id).filter((i) => i.kind === 'agent' && i.sessionId === se.id);

/** A Store on disk whose log sync can be held, so an emit made meanwhile is held behind the commit, unseen by items(). */
export async function heldStore() {
  const dir = await mkdtemp(join(tmpdir(), 'pb-stop-held-'));
  folders.push(dir);
  let hold = false;
  let release = () => {};
  let reached = () => {};
  const atSync = new Promise((r) => {
    reached = () => r(undefined);
  });
  const io = disk({
    open: async (path, ...args) => {
      const fh = await fs.open(path, ...args);
      if (!/events-\d+\.jsonl$/.test(String(path))) return fh;
      return handleWith(fh, {
        sync: async () => {
          if (hold) {
            hold = false;
            reached();
            await new Promise((r) => {
              release = () => r(undefined);
            });
          }
          return fh.sync();
        },
      });
    },
  });
  const store = await new Store(dir, { io }).load();
  return { store, hold: () => (hold = true), atSync, release: () => release() };
}
