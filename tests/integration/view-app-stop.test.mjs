// Stopping Postbox closes view_app’s browser (#95; designs/architecture.md, “Agents see their app”), and a card a
// killed Postbox left downloading says so on the next start, instead of downloading for good.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { start } from '../../server/index.mjs';
import { STOPPED } from '../../server/view-app/browser.mjs';
import { viewOf } from '../../server/view-app/view-of.mjs';
import { freePort } from '../process/chrome.mjs';
import { assertNoServerFailures, captureServerLog } from '../server-log.mjs';
import { tempDir } from '../temp-dirs.mjs';

// The Postboxes it starts run in this process: a test fails on an error one logs (tests/server-log.mjs).
captureServerLog();
afterEach(assertNoServerFailures);

test('stop closes view_app’s browser, and the next start settles a card left downloading', async () => {
  const root = tempDir('pb-view-stop-');
  const work = join(root, 'work');
  mkdirSync(work);
  // demo: no real backends are looked for, so no CLI runs or leaves anything behind.
  const opts = { dataDir: join(root, 'data'), demo: true, quiet: true, claudeHome: root };
  /** The Postbox an assert left running, closed so the file’s process exits and tempDir removes the folder (#921). */
  let open = /** @type {{ close: () => Promise<void> } | null} */ (null);
  try {
    const first = await start({ ...opts, port: await freePort(), fresh: true });
    open = first;
    const { rt, store } = first;
    store.emit('project', { id: 'pv', name: 'View app', folder: work });
    const t = rt.createThread({ projectId: 'pv', title: 'Cut short', personaIds: [rt.personaByHandle('researcher').id] });
    const se = rt.sessionsIn(t.id)[0];
    const card = rt.addItem(t.id, { kind: 'viewask', sessionId: se.id, handle: se.handle, turnId: null, status: 'downloading' });
    let closed = 0;
    const close = viewOf(rt).close.bind(viewOf(rt));
    viewOf(rt).close = () => {
      closed++;
      return close();
    };
    open = null;
    await first.close();
    assert.equal(closed, 1, 'stop closed the browser');

    const second = await start({ ...opts, port: await freePort() });
    try {
      const after = second.rt.store.items(t.id).find((x) => x.id === card.id);
      assert.equal(after.status, 'failed');
      assert.equal(after.reason, STOPPED);
    } finally {
      await second.close();
    }
  } finally {
    await open?.close();
  }
});
