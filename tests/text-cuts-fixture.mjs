// What the #1686 sweep’s tests share (text-cuts-sweep*.test.mjs): text with an emoji across a cut, the check that a
// string holds no lone half of a surrogate pair, and a conversation with one agent whose tools a test calls.

import assert from 'node:assert/strict';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';

export const EMOJI = '😀';

/** Text whose emoji starts at the last character a cut at n keeps, so a raw slice keeps half of it. */
export const across = (n, pad = 'x') => pad.repeat(n - 1) + EMOJI + 'tail';

/** Whether text holds a lone half of a surrogate pair. */
export const lone = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(String(s));

/** Fails unless s is text with no lone half of a pair. @param {unknown} s @param {string} where */
export function whole(s, where) {
  assert.ok(typeof s === 'string' && s.length > 0, `${where} wasn’t found`);
  assert.equal(lone(s), false, `${where} ends inside a character`);
}

/** A conversation with one agent, @alpha, on a mock backend whose turns do nothing. */
export function room() {
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({ name: 'mock', async folderFor() {}, fork() {}, async deliver() {} }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [rt.createPersona({ handle: 'alpha' }).id] });
  const se = arrange.agentIn(rt, t.id);
  const items = (/** @type {string} */ kind) => store.items(t.id).filter((i) => i.kind === kind);
  return { rt, store, t, se, tools: rt.toolsFor(se.id), items };
}
