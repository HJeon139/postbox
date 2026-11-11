// ⌃J orders the agents that need you by when each ask was posted (#285). The page holds no items of a conversation it
// hasn't opened (#1155), so the session keeps its need's item time beside it (needsAt), stamped when the server records
// the need, and waitedSince reads that rather than the item. A session that needed you before needsAt gets it as the
// store loads.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { sessionPatch } from '../server/session-patch.mjs';
import { waitedSince } from '../shared/needs.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

let app;
let dir = '';
const boot = (fresh) => start({ port: 4498, dataDir: dir, fresh, demo: true, quiet: true, claudeHome: dir, listen: false });
before(async () => {
  dir = await tempDir('pb-needs-at-');
  app = await boot(true);
});
after(async () => {
  await app.close();
});

/** A session in a new conversation that needs you, on a confirm card it posted. */
function needing(title) {
  const projectId = Object.values(app.store.state.projects)[0].id;
  const t = app.rt.createThread({ projectId, title, personaIds: [app.rt.personaByHandle('researcher').id] });
  const [se] = app.rt.sessionsIn(t.id);
  const card = app.rt.addItem(t.id, {
    kind: 'block',
    sessionId: se.id,
    valid: true,
    answered: false,
    block: { id: 'na', type: 'confirm', version: 1, fallback: 'Go?', statement: 'Go?', confirmLabel: 'Go' },
  });
  app.rt.updateSession(se.id, { state: 'needs', needs: { kind: 'block', itemId: card.id, text: 'Go?' } });
  return { se, card };
}

test('a need records its item’s time, and waitedSince reads it with no items in the state', () => {
  const { se, card } = needing('Needs at');
  const now = app.store.state.sessions[se.id];
  assert.deepEqual(now.needsAt, { itemId: card.id, at: card.at });
  app.rt.updateSession(se.id, { updatedAt: card.at + 60_000 });
  const page = { threads: app.store.state.threads, items: {} };
  assert.equal(waitedSince(page, app.store.state.sessions[se.id]), card.at, 'not the session’s last change');
});

test('a session that needed you before needsAt gets its item’s time as the store loads', async () => {
  const { se, card } = needing('Needs from before');
  // As a session saved before needsAt was: its need, and no time beside it.
  app.store.emit('session.patch', sessionPatch(app.store.state.sessions[se.id], { needsAt: undefined }));
  assert.equal(app.store.state.sessions[se.id].needsAt, undefined);
  await app.close();
  app = await boot(false);
  assert.deepEqual(app.store.state.sessions[se.id].needsAt, { itemId: card.id, at: card.at });
});
