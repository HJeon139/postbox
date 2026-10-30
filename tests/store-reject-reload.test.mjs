// gpt’s peer review of 0e68a9f0 (#553): the repair’s write lands and is acknowledged, then the state reload that follows
// loses its connection. With confirmed already advanced, catchUp() returned at “seq <= confirmed” before asking about the
// pending repair, so the store stayed EREJECTED with the refused change in memory. Pending repairs are checked first.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retry } from '../server/store-recover.mjs';
import { open, poison, raw, tmp, until } from './store-fixture.mjs';

test('Retry recovers a repair whose commit succeeded but the following state read lost its reply', async () => {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  await s.flush();
  const client = poison(s, 'project:bad');
  s.emit('item.add', { threadId: 't', item: { id: 'x', kind: 'user', text: 'one', at: 1 } });
  s.emit('project', { id: 'bad', name: 'poison' });
  s.emit('item.patch', { threadId: 't', id: 'x', patch: { text: 'two' } });
  await s.flush();
  const call = client.call;
  let lost = false,
    committed = false;
  client.call = async (...a) => {
    if (committed && !lost && a[0] === 'GET' && a[1] === 'seq') {
      lost = true;
      throw Object.assign(Error('lost the state read after a successful repair'), { code: 'ESTOREDOWN' });
    }
    const r = await call(...a);
    if (a[0] === 'EVAL' && Number(a[5]) > 0) committed = true;
    return r;
  };
  await retry(s);
  assert.equal(lost, true);
  // A fresh connection sees the successful repair. Simulate the reconnect that follows a real lost connection.
  client.ondrop();
  await until(() => s.writable, 'writes to reopen after the reconnect', s);
  const c = await raw(s);
  try {
    assert.equal(await c.call('GET', 'seq'), '4');
  } finally {
    c.close();
  }
  assert.equal(s.writable, true, `recovery stayed closed: ${s.failed?.code}: ${s.failed?.message}`);
  assert.equal(s.state.projects.bad, undefined, 'the refused project is removed from memory');
  assert.equal(s.state.items.t[0].text, 'two');
});
