// A store test’s wait for a restarted child’s catch-up, run in a Node of its own (tests/process/store-kill-fixture.test.mjs):
// opens a store on the data folder in argv, loses a commit’s reply (the EVAL runs, then the child is SIGKILLed), holds
// the restarted child’s catch-up at its first `GET seq`, and awaits that gate; then lets catch-up on, waits for writes
// to reopen and exits 0. With `bare`, the gate is awaited as is: once the catch-up’s backoff timer has fired, only the
// supervisor’s unref’d restart timer remains, so Node exits with the wait pending (exit 13, “unsettled top-level
// await”). With `held`, it’s awaited through `holding`, which keeps the loop alive, as a test file must. The restart
// wait in argv (ms) puts the restart after the backoff, as Linux’s late report of the death does on CI.

import { Store } from '../../server/store.mjs';
import { holdCatchUp, holding, loseReply } from '../store-kill-fixture.mjs';

const [dataDir, mode, restartMs] = process.argv.slice(2);
const s = await new Store(dataDir).load();
if (restartMs) s.redis.sup.restartMs = Number(restartMs);
s.emit('thread', { id: 't', members: [] });
s.emit('item.add', { threadId: 't', item: { id: 'i', text: 'a' } });
await s.flush();
loseReply(s);
const reading = holdCatchUp(s);
await s.commit([{ type: 'item.text', data: { threadId: 't', id: 'i', text: 'b' } }], 'lost').catch((e) => console.log(`REFUSED ${e.code}`));
if (mode === 'bare') await reading.hit;
else await holding(reading.hit, 'catch-up to read seq on the restarted child', s);
console.log(`HIT ${s.status.state}:${s.status.cause}`);
reading.go();
for (let i = 0; i < 200 && !s.writable; i++) await new Promise((ok) => setTimeout(ok, 25));
console.log(`WRITABLE ${s.writable} ${s.state.items.t[0].text}`);
await s.close();
