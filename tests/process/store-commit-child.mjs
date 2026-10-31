// A store writing a commit, run in a Node of its own to be SIGKILLed (tests/process/store-commit-kill.test.mjs): opens
// a store on the data folder in argv, writes one event the old way, then commits three events through a `sync` that
// says SYNCING on stdout and never returns, so the parent can kill it while the commit is on disk but not yet
// acknowledged. It never prints COMMITTED: a commit resolves only once its line is fsynced.

import { Store } from '../../server/store.mjs';
import { holding } from '../store-kill-fixture.mjs';

const [dataDir] = process.argv.slice(2);
let armed = false;
const s = await new Store(dataDir, {
  sync: async (fh) => {
    if (!armed) return fh.sync();
    process.stdout.write('SYNCING\n');
    await holding(new Promise(() => {}), 'the parent to kill this process', 30_000);
  },
}).load();
s.emit('thread', { id: 't0', members: [] });
await s.flush();
armed = true;
await s.commit(
  [
    { type: 'thread', data: { id: 't1', members: [] } },
    { type: 'thread', data: { id: 't2', members: [] } },
    { type: 'item.add', data: { threadId: 't1', item: { id: 'i1', text: 'hi' } } },
  ],
  'killed',
);
process.stdout.write('COMMITTED\n');
