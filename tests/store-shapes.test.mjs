// ST-1 (#508’s requirements, “Storage”; design 6.6, decisions 4 and 5): a value’s shape can change between versions
// with no migration run on existing installs. A document older than the shape this Postbox writes is lifted on read,
// one version step at a time, and never rewritten by reading it; nothing runs at startup. Production has one shape so
// far (DOC_V 1, no steps), so the test gives its store a second, test-only shape: version 2 of a conversation keeps its
// title under `title` where version 1 had `name`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { DOC_V } from '../server/store-docs.mjs';
import { admin, open, tmp } from './store-fixture.mjs';

/** A test-only shape 2: a conversation’s `name` becomes its `title`. Every other document is the same in both. */
const SHAPE_2 = {
  v: 2,
  up: {
    1: (/** @type {any} */ d, /** @type {string} */ key) => {
      if (!key.startsWith('thread:')) return d;
      const { name, ...rest } = d;
      return { ...rest, title: name };
    },
  },
};

/** What a write to Redis would change: commands Redis counts as writes, since CONFIG RESETSTAT. */
const WRITES = /^cmdstat_(json\.set|json\.del|json\.merge|set|del|rename|zadd|zrem|xadd|xtrim|eval|evalsha|hset|incr|expire)\b/;

test('ST-1: a document written in an older shape reads in the current one, with nothing rewritten and nothing run at startup', async () => {
  assert.equal(DOC_V, 1, 'production’s shape is still 1; this test adds a second only for itself');
  const dir = await tmp();
  const older = await open(dir);
  older.emit('thread', { id: 't', name: 'Written by an older Postbox', members: [] });
  older.emit('item.add', { threadId: 't', item: { id: 'i', text: 'hello' } });
  await older.flush();
  const c = await admin(older);
  // As the older Postbox left it: shape 1.
  const doc = await c.call('JSON.GET', 'thread:t', '$');
  assert.equal(JSON.parse(doc)[0].v, 1);
  const before = { seq: await c.call('GET', 'seq'), events: await c.call('XLEN', 'events'), keys: (await c.call('KEYS', '*')).sort() };
  await c.call('CONFIG', 'RESETSTAT');

  // An upgraded Postbox, whose documents are shape 2, starts on the same data.
  const newer = await new Store(dir, { shapes: SHAPE_2 }).load();
  try {
    assert.equal(newer.state.threads.t.title, 'Written by an older Postbox', 'read in the current shape');
    assert.equal('name' in newer.state.threads.t, false);
    assert.equal(newer.state.items.t[0].text, 'hello', 'a document the step doesn’t change reads as it was');
    // Nothing was written to lift it, at startup or on read.
    const stats = String(await c.call('INFO', 'commandstats'))
      .split(/\r?\n/)
      .filter((l) => WRITES.test(l));
    assert.deepEqual(stats, [], 'no write command ran');
    assert.equal(await c.call('JSON.GET', 'thread:t', '$'), doc, 'the document in Redis is byte for byte what the older Postbox wrote');
    assert.deepEqual(
      { seq: await c.call('GET', 'seq'), events: await c.call('XLEN', 'events'), keys: (await c.call('KEYS', '*')).sort() },
      before,
      'and nothing else changed',
    );
  } finally {
    c.close();
    await newer.close();
  }
});
