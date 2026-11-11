// #338: a read card about a folder (Antigravity’s list_dir, grep_search and find_by_name send it as file_path) offers
// that folder, not the one holding it, so the person isn’t asked about a wider one and a listing just under home gets
// an offer. And a folder saved with Always allow is read in the same turn with no second card, by the session’s list
// as it is now, not as the turn started with it.

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { readFolderOffer } from '../server/read-folders.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A home with a project, a notes folder just under home and one whose name starts with it, and a designs folder in the project. */
function aHome() {
  const home = realpathSync(tempDir('pb-read-target-'));
  const ws = join(home, 'ws');
  const notes = join(home, 'notes');
  const designs = join(ws, 'designs');
  for (const d of [ws, notes, `${notes}-old`, designs, join(home, '.ssh')]) mkdirSync(d, { recursive: true });
  for (const f of [join(notes, 'a.md'), join(notes, 'b.md'), join(`${notes}-old`, 'a.md'), join(designs, 'a.md'), join(home, 'top.md')]) writeFileSync(f, 'x');
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key');
  // A link in the notes folder to a key in ~/.ssh, as one already there might be.
  symlinkSync(join(home, '.ssh', 'id_ed25519'), join(notes, 'keys'));
  return { home, ws, notes, designs };
}

const offerFor = (path, home) => readFolderOffer({ backend: 'antigravity-cli', tool: 'Read', input: { file_path: path }, home })?.readDir ?? null;

test('#338 a card about a folder offers that folder, not the one holding it', () => {
  const { home, notes, designs } = aHome();
  assert.equal(offerFor(designs, home), designs, 'a listing inside the project offers the folder listed');
  assert.equal(offerFor(notes, home), notes, 'a listing just under home offers that folder, not home');
  assert.equal(offerFor(`${designs}/`, home), designs, 'with a trailing slash too');
  assert.equal(offerFor(join(designs, 'a.md'), home), designs, 'a file still offers its folder');
  assert.equal(offerFor(join(home, '.ssh'), home), null, 'a dot-folder in home is never offered');
  assert.equal(offerFor(home, home), null, 'nor home itself');
});

/** A runtime with an Antigravity agent (or another backend) in a conversation, whose turn runs `during`. */
function aRoom(home, ws, backend = 'antigravity-cli') {
  const store = new Store(null);
  const adapter = {
    name: backend,
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
  const p = rt.createPersona({ handle: 'gem', backend, permissionMode: 'ask' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  return { rt, store, adapter, t, se: rt.sessionsIn(t.id)[0] };
}

/** Runs one turn, in which the folder is saved readable mid-turn and then `ask` asks for a read. */
async function readAfterSaving({ home, ws, dir, file, backend }) {
  const { rt, store, adapter, t, se } = aRoom(home, ws, backend);
  /** @type {any[]} */
  const results = [];
  adapter.during = async () => {
    rt.updateSession(se.id, { readDirs: [dir] });
    const asked = rt.requestPermission(se.id, { tool: 'Read', summary: 'read', input: { file_path: file } });
    await sleep(10);
    const cards = store.items(t.id).filter((i) => i.kind === 'permission');
    for (const c of cards.filter((i) => i.status === 'open')) rt.settlePermission(c.id, 'denied', 'test');
    results.push({ result: await asked, cards: cards.length });
  };
  rt.sendMessage(t.id, { text: 'read the notes' });
  for (let i = 0; i < 200 && !results.length; i++) await sleep(5);
  return results[0];
}

test('#338 a read in a folder saved earlier in the same turn is allowed with no card', async () => {
  const { home, ws, notes } = aHome();
  const { result, cards } = await readAfterSaving({ home, ws, dir: notes, file: join(notes, 'b.md') });
  assert.equal(cards, 0, 'no second card for the folder just allowed');
  assert.equal(result.allow, true);
});

test('#338 a saved folder allows nothing outside it, nor for another backend', async () => {
  const { home, ws, notes } = aHome();
  const outside = await readAfterSaving({ home, ws, dir: notes, file: join(home, 'top.md') });
  assert.equal(outside.cards, 1, 'a read outside it still asks');
  const sibling = await readAfterSaving({ home, ws, dir: notes, file: `${notes}-old/a.md` });
  assert.equal(sibling.cards, 1, 'a folder whose name only starts with it still asks');
  const other = await readAfterSaving({ home, ws, dir: notes, file: join(notes, 'b.md'), backend: 'claude-code' });
  assert.equal(other.cards, 1, 'Claude Code keeps its own rules');
});

// #338: a file is judged by where it leads, as the hook judges it, not by the folder holding the link.
test('#338 a link in a saved folder to a key in ~/.ssh still asks, and offers nothing', async () => {
  const { home, ws, notes } = aHome();
  const link = join(notes, 'keys');
  const { result, cards } = await readAfterSaving({ home, ws, dir: notes, file: link });
  assert.equal(cards, 1, 'a card, since the file it reads is in ~/.ssh');
  assert.equal(result.allow, false);
  assert.equal(offerFor(link, home), null, 'and no Always allow for ~/.ssh');
});

test('#1074 a folder in home whose name starts with two dots is a dot-folder, never offered', () => {
  const { home } = aHome();
  const dots = join(home, '..notes');
  mkdirSync(dots);
  writeFileSync(join(dots, 'a.md'), 'x');
  assert.equal(offerFor(join(dots, 'a.md'), home), null);
  assert.equal(offerFor(dots, home), null, 'nor when the card is about the folder itself');
});
