// A store writing a commit, run in a Node of its own to be SIGKILLed (tests/process/store-commit-kill.test.mjs): opens
// a store on the data folder in argv, writes one event the old way, then commits three events through an `io` whose
// log fsync says SYNCING on stdout and never returns, so the parent can kill it while the commit is on disk but not yet
// acknowledged. It never prints COMMITTED: a commit resolves only once its line is fsynced.

import * as fs from 'node:fs/promises';
import { Store } from '../../server/store.mjs';
import { disk, handleWith } from '../store-jsonl-fixture.mjs';
import { holding } from '../store-kill-fixture.mjs';

const [dataDir] = process.argv.slice(2);
let armed = false;
const io = disk({
  open: async (path, ...args) => {
    const handle = await fs.open(path, ...args);
    if (!/events-\d+\.jsonl$/.test(String(path))) return handle;
    return handleWith(handle, {
      sync: async () => {
        if (!armed) return handle.sync();
        process.stdout.write('SYNCING\n');
        await holding(new Promise(() => {}), 'the parent to kill this process', 30_000);
      },
    });
  },
});
const s = await new Store(dataDir, { io }).load();
s.emit('thread', { id: 't0', members: [] });
await s.flush();
armed = true;
await s.commit(
  [
    { type: 'thread', data: { id: 't1', members: [] } },
    { type: 'thread', data: { id: 't2', members: [] } },
    { type: 'item.add', data: { threadId: 't1', item: { id: 'i1', text: 'hi' } } },
  ],
  { opId: 'killed' },
);
process.stdout.write('COMMITTED\n');
