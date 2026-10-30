// A store test’s kill of its Redis child, run in a Node of its own (tests/process/store-kill-fixture.test.mjs): opens a
// store on the data folder in argv, writes to it, kills the child the way the store’s tests do, waits for writes to
// reopen, writes again and exits 0. Nothing but that wait holds its event loop, as nothing does in a test file either.

import { Store } from '../../server/store.mjs';
import { killed } from '../store-kill-fixture.mjs';

const [dataDir] = process.argv.slice(2);
const s = await new Store(dataDir).load();
s.emit('thread', { id: 't', members: [] });
await s.flush();
await killed(s);
console.log(`DOWN ${s.redis.sup.status.state}`);
for (let i = 0; i < 200 && !s.writable; i++) await new Promise((ok) => setTimeout(ok, 25));
console.log(`WRITABLE ${s.writable}`);
s.emit('thread', { id: 'u', members: [] });
await s.flush();
console.log(`WRITTEN ${Object.keys(s.state.threads).sort().join(',')}`);
await s.close();
