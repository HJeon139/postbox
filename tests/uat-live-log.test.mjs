// The UAT checks over a log written in windows (designs/architecture/live-progress.md, “What reads the store while a
// turn runs”): every recorded turn in tests/fixtures/ is replayed through the real runtime into a store on disk, as
// tools/measure-progress.mjs replays them, and what the checks rebuild of each reply from the log (itemsOf, which
// tools/uat/inbox-measures.mjs and picture-choice.mjs read as they did when every delta was stored) is the reply
// Postbox kept: all its words, in order, each stored before the reply settles.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopTimers } from '../server/runtime-close.mjs';
import { Store } from '../server/store.mjs';
import { play, scriptTurns, settled, ticking, virtualClock } from '../tools/measure-progress/drive.mjs';
import { notARepository, turnsOfAll } from '../tools/measure-progress/fixtures.mjs';
import { itemsOf } from '../tools/uat/inbox-measures.mjs';
import { logEvents } from '../tools/uat/picture-choice.mjs';
import { setup } from './side-threads-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

/**
 * One recorded turn, by @beta, played into a store in a temp folder: the log it wrote, the replies Postbox kept, and
 * every word the stream gave Postbox, by the reply it went to, as `main` stored them, a delta at a time.
 * @param {any} rec
 */
async function replayed(rec) {
  const dir = tempDir('pb-uat-live-log-');
  const store = await new Store(dir).load();
  const f = setup(store);
  f.rt.ledger.git = notARepository;
  /** @type {Map<string, string>} */
  const said = new Map();
  /** A turn’s context whose words are noted as they’re given. @param {any} c */
  const noting = (c) => ({
    __proto__: c,
    text(/** @type {string} */ delta) {
      c.text(delta);
      // The part it went to is the one this turn, known by its signal, now holds words for (server/live-text.mjs).
      const id = f.rt.running.all().find((/** @type {any} */ t) => t.abort.signal === c.signal)?.liveText?.itemId;
      if (delta && id) said.set(id, (said.get(id) ?? '') + delta);
    },
  });
  const mapper = (/** @type {any} */ c) => rec.mapper(noting(c));
  const slots = scriptTurns(f.adapter, [{ ...rec, mapper }]);
  // A turn the recorded one leads to (a wake, a lint) gets the fixture adapter’s “ok”, noted the same way.
  for (let i = 0; i < 10; i++) f.adapter.next.push(async (/** @type {any} */ c) => noting(c).text('ok'));
  f.rt.sendMessage(f.t.id, { text: '@beta go' });
  await play(slots);
  await settled(f.rt);
  await ticking(f.rt.work.idle());
  const kept = store.items(f.t.id).filter((/** @type {any} */ i) => i.kind === 'agent');
  stopTimers(f.rt);
  await ticking(store.close());
  return { events: logEvents(dir), kept, said };
}

test('what the UAT checks rebuild of each reply from the log is the reply Postbox kept, for every recorded turn', async () => {
  virtualClock();
  const recs = turnsOfAll();
  assert.ok(recs.length >= 20, `the fixtures’ recorded turns are all here: ${recs.length}`);
  let words = 0;
  for (const rec of recs) {
    const { events, kept, said } = await replayed(rec);
    const rebuilt = new Map(itemsOf(events).map((i) => [i.id, i]));
    for (const reply of kept) {
      const r = rebuilt.get(reply.id);
      assert.equal(r?.text, said.get(reply.id) ?? '', `${rec.name}: ${reply.id}’s words, from the log, are every word the stream gave it`);
      assert.equal(r?.text, reply.text, `${rec.name}: ${reply.id}’s words, from the log, are the reply’s`);
      assert.equal(r?.status, reply.status, `${rec.name}: ${reply.id}’s status, from the log`);
      // Each of its words is stored before it settles, so a check reading in order has them all by then.
      const settles = events.findIndex(
        (e) => e.type === 'item.patch' && e.data?.id === reply.id && e.data.patch?.status && e.data.patch.status !== 'streaming',
      );
      const lastWords = events.findLastIndex((e) => e.type === 'item.text' && e.data?.id === reply.id);
      assert.ok(lastWords < settles, `${rec.name}: ${reply.id}’s words are stored before it settles`);
      words += reply.text.length;
    }
  }
  assert.ok(words > 1000, `the replies said something: ${words} characters`);
});
