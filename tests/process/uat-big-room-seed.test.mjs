// `- seed: big-room` in a run (#508, tools/uat/big-room.mjs, openBigRoom): once the page has started the run's
// conversation, the runner stops its Postbox, writes the generated room into that conversation in Postbox's store,
// starts Postbox again on the same data and opens the room. A real Postbox, on mock agents.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../../server/store.mjs';
import { openBigRoom } from '../../tools/uat/big-room.mjs';
import { startPostbox } from '../../tools/uat/postbox.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const data = mkdtempSync(join(tmpdir(), 'pb-big-room-seed-'));
after(() => rmSync(data, { recursive: true, force: true }));

/** A port nothing listens on. @returns {Promise<number>} */
const freePort = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
      s.close(() => ok(port));
    });
  });

test('the runner seeds the big room into the conversation the page started, and opens it', async () => {
  const lines = [];
  const postbox = await startPostbox({ root: ROOT, port: await freePort(), data, env: { POSTBOX_BACKENDS: 'mock' }, log: (l) => lines.push(l) });
  try {
    // What the page's New room would have made: a room and its agents' sessions. Written while Postbox is down.
    await postbox.restart({
      whileDown: async () => {
        const store = await new Store(data).load();
        store.emit('thread', { id: 'th_big', kind: 'room', title: 'The release, in a long room', members: ['se_r'] });
        store.emit('session', { id: 'se_r', threadId: 'th_big', handle: 'researcher', personaId: 'pe_r' });
        await store.close();
      },
    });
    const opened = [];
    const page = { goto: async (url) => opened.push(url) };
    const note = await openBigRoom({ postbox, data, threadId: 'th_big', agents: ['researcher'], page, log: (l) => lines.push(l) });
    const { state } = await postbox.api('/api/state');
    assert.equal(state.items.th_big.length, 1000, lines.join('\n'));
    assert.equal(state.items.th_big[0].id, 'it_big0000');
    assert.deepEqual(opened, [`${postbox.origin}/#/t/th_big`]);
    assert.match(note, /#\/t\/th_big\?at=it_big0005/);
  } finally {
    await postbox.kill();
  }
});
