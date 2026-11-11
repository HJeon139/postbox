// #1074: a readable folder removed in the Permissions panel mid-turn takes effect on the next read. The hook’s
// environment is the turn’s start, so the hook leaves a readable folder to Postbox, whose inReadFolder reads the
// session as it is now, and from its pending state, so a removal still held behind a commit counts at once.

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { runAgyHook } from '../server/adapters/agy-hook.mjs';
import { agyHookVars } from '../server/adapters/antigravity-cli.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { changePermissionFolder } from '../server/permissions-panel.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { heldStore } from './stop-reply-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A home with a project and a folder of notes outside it. */
function aHome() {
  const home = realpathSync(tempDir('pb-read-removed-'));
  const ws = join(home, 'ws');
  const notes = join(home, 'notes');
  for (const d of [ws, notes]) mkdirSync(d, { recursive: true });
  writeFileSync(join(notes, 'a.md'), 'x');
  return { home, ws, notes };
}

/** A runtime with an Antigravity agent in Ask, whose turn runs `during`, its notes folder saved as readable. */
function aRoom(store, { home, ws, notes }) {
  const adapter = {
    name: 'antigravity-cli',
    capabilities: { promptTool: true, promptHook: true, permissions: 'none' },
    during: /** @type {any} */ (null),
    async deliver(_s, _m, ctx) {
      await this.during?.(ctx);
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: ws });
  const p = rt.createPersona({ handle: 'gem', backend: 'antigravity-cli', permissionMode: 'ask' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  rt.updateSession(se.id, { readDirs: [notes] });
  return { rt, adapter, t, se };
}

/** Runs one turn of `during`, and waits for it to finish. */
async function aTurn(rt, adapter, t, during) {
  let done = false;
  adapter.during = async (/** @type {any} */ ctx) => {
    try {
      await during(ctx);
    } finally {
      done = true;
    }
  };
  rt.sendMessage(t.id, { text: 'read the notes' });
  for (let i = 0; i < 400 && !done; i++) await sleep(5);
  assert.ok(done, 'the turn ran');
}

/** The hook as the turn runs it: its environment from the turn’s start, its cards asked of this runtime’s /mcp. */
function hookOf(rt, se, ctx, cwd, home) {
  const env = agyHookVars({ mcpUrl: 'http://127.0.0.1:1/mcp', persona: ctx.persona, cwd, addDirs: ctx.addDirs });
  const fetchImpl = async (/** @type {string} */ _url, /** @type {any} */ init) => ({
    ok: true,
    status: 200,
    json: async () => handleMcp(rt, se.id, JSON.parse(init.body), rt.turns.get(se.id)?.token ?? null),
  });
  const opts = { cwd, env, home, fetchImpl: /** @type {any} */ (fetchImpl) };
  return (/** @type {string} */ file) => runAgyHook(JSON.stringify({ toolCall: { name: 'view_file', args: { AbsolutePath: file } } }), opts);
}

/**
 * Reads `file` through the hook; refuses the card it opens, if one does, and says whether one did. By the card’s wait,
 * since a card added behind a held commit isn’t in the published items yet.
 */
async function readOnce(rt, hook, file) {
  const asked = hook(file);
  await sleep(10);
  const [card] = rt.permissionWaits.keys();
  if (card) rt.settlePermission(card, 'denied', 'test');
  return { result: await asked, card: Boolean(card) };
}

test('#1074 a readable folder removed in the panel mid-turn gets a card on the next read', async () => {
  const where = aHome();
  const { rt, adapter, t, se } = aRoom(new Store(null), where);
  const file = join(where.notes, 'a.md');
  /** @type {any[]} */
  const reads = [];
  await aTurn(rt, adapter, t, async (ctx) => {
    const hook = hookOf(rt, se, ctx, where.ws, where.home);
    reads.push(await readOnce(rt, hook, file));
    await changePermissionFolder(rt, { sessionId: se.id, path: where.notes, remove: true, read: true });
    reads.push(await readOnce(rt, hook, file));
  });
  assert.deepEqual(reads[0], { result: { decision: 'allow' }, card: false }, 'readable: no card');
  assert.equal(reads[1].card, true, 'removed: a card on the next read');
  assert.equal(reads[1].result.decision, 'deny');
});

// A read decides an allow, so a removal written behind a commit still being written counts at once (#796’s class).
test('#1074 a readable folder removed behind a held commit gets a card on the next read', async () => {
  const where = aHome();
  const h = await heldStore();
  const { rt, adapter, t, se } = aRoom(h.store, where);
  await h.store.flush();
  /** @type {any} */
  let read = null;
  await aTurn(rt, adapter, t, async (ctx) => {
    const hook = hookOf(rt, se, ctx, where.ws, where.home);
    h.hold();
    const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
    await h.atSync;
    await changePermissionFolder(rt, { sessionId: se.id, path: where.notes, remove: true, read: true });
    assert.deepEqual(rt.s.sessions[se.id].readDirs, [where.notes], 'the removal is still held');
    read = await readOnce(rt, hook, join(where.notes, 'a.md'));
    h.release();
    await commit;
  });
  assert.equal(read?.card, true, 'removed: a card on the next read');
  assert.equal(read?.result.decision, 'deny');
  await h.store.close();
});
