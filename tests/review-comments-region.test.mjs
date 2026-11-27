// A comment on a region of an app (#856): the person clicks a point or drags a box on the app in its review, and the
// comment carries it in CSS px of the app’s page, with the size of the frame it was marked in and the app version it was
// made on. The shared rule checks it wherever a comment enters, and the agent reads it with the comment.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBlock } from '../shared/catalog.mjs';
import { buildEvent } from '../shared/events.mjs';
import { commentAt, commentErrors } from '../shared/review-comments.mjs';
import { regionAnchor } from '../shared/review-regions.mjs';
import { settle, setup, turn } from './blocks-fixture.mjs';

const box = { x: 120, y: 90, w: 200, h: 45, width: 1000, height: 300, version: 3 };
const onBox = { anchor: 'region 1', region: box, text: 'This label overlaps.' };

test('#856 a comment on a box or a point of an app is a comment', () => {
  assert.deepEqual(commentErrors(onBox, 'c'), []);
  assert.deepEqual(commentErrors({ anchor: 'region 2', region: { ...box, x: 500, y: 150, w: 0, h: 0 }, text: 'Here.' }, 'c'), []);
  // A box to the app’s right and bottom edges.
  assert.deepEqual(commentErrors({ anchor: 'region 3', region: { ...box, x: 700, y: 270, w: 300, h: 30 }, text: 'Edge.' }, 'c'), []);
});

test('#856 a region’s place and its frame’s size are whole CSS px, within REGION_PX', () => {
  for (const [k, v, why] of [
    ['x', -1, 'must be between 0 and 10000'],
    ['y', 0.5, 'must be a whole number'],
    ['w', 10_001, 'must be between 0 and 10000'],
    ['h', '10', 'must be a whole number'],
    ['width', 0, 'must be between 1 and 10000'],
    ['height', 200_001, 'must be between 1 and 200000'],
  ]) {
    const errs = commentErrors({ ...onBox, region: { ...box, [k]: v } }, 'c');
    assert.ok(
      errs.some((e) => e.startsWith(`c.region.${k} ${why}`)),
      `${k} = ${JSON.stringify(v)}: ${errs.join(' ')}`,
    );
  }
});

test('#856 a region names the size of the frame it was marked in', () => {
  const { width: _, ...noWidth } = box;
  assert.deepEqual(commentErrors({ ...onBox, region: noWidth }, 'c'), ['c.region.width is required.']);
  const { height: __, ...noHeight } = box;
  assert.deepEqual(commentErrors({ ...onBox, region: noHeight }, 'c'), ['c.region.height is required.']);
});

test('#856 a region stays inside the frame it was marked in: x + w is at most width, y + h at most height', () => {
  const why = ['c: a region stays inside the app: x + w is at most width, and y + h at most height.'];
  assert.deepEqual(commentErrors({ ...onBox, region: { ...box, x: 900, w: 101 } }, 'c'), why);
  assert.deepEqual(commentErrors({ ...onBox, region: { ...box, y: 290, h: 11 } }, 'c'), why);
});

test('#856 a region names the app version it was made on', () => {
  const { version: _, ...noVersion } = box;
  assert.deepEqual(commentErrors({ ...onBox, region: noVersion }, 'c'), ['c.region.version is required.']);
  assert.deepEqual(commentErrors({ ...onBox, region: { ...box, version: 0 } }, 'c'), ['c.region.version must be between 1 and 1000000.']);
});

test('#856 a comment on a region names it as anchor, “region 1”', () => {
  const why = ['c: a comment on a region names it as anchor, such as “region 1”.'];
  assert.deepEqual(commentErrors({ line: 2, region: box, text: 'Hm.' }, 'c'), why);
  assert.deepEqual(commentErrors({ ...onBox, anchor: 'chart' }, 'c'), why);
});

test('#856 a “region N” anchor carries its region: a part can’t take that name', () => {
  assert.deepEqual(commentErrors({ anchor: 'region 1', text: 'Hm.' }, 'c'), [
    'c: “region 1” names a marked region, so it needs its region: { x, y, w, h, width, height, version }.',
  ]);
  // Other names are parts, as before.
  assert.deepEqual(commentErrors({ anchor: 'regional sales', text: 'Hm.' }, 'c'), []);
  // A review stored before #856 with a part an app named “region 1” keeps its thread: the rule is on new comments.
  const app = { id: 'r', type: 'review', version: 1, fallback: 'R', format: 'app', appId: 'a' };
  const old = { id: 't1', status: 'open', anchor: 'region 1', comments: [{ author: '@critic', text: 'Hm.' }] };
  assert.equal(validateBlock({ ...app, threads: [old] }).ok, true);
});

test('#856 a review’s threads can’t put two regions under one “region N”', () => {
  const thread = (id, region) => ({ id, status: 'open', anchor: 'region 1', region, comments: [{ author: '@researcher', text: 'Hm.' }] });
  const app = { id: 'r', type: 'review', version: 1, fallback: 'R', format: 'app', appId: 'a' };
  const clash = validateBlock({ ...app, threads: [thread('t1', box), thread('t2', { ...box, x: 500 })] });
  assert.equal(clash.ok, false);
  assert.match(clash.errors.join(' '), /threads\[1\]: “region 1” is already threads\[0\]’s region; give this one the next number\./);
  // Two threads on the same region, such as a reply in a new thread, are fine.
  assert.equal(validateBlock({ ...app, threads: [thread('t1', box), thread('t2', box)] }).ok, true);
});

test('#856 the agent reads a region with its place, its size, its version and its frame’s size, and a point as a point', () => {
  assert.equal(commentAt(onBox), '“region 1” (x 120, y 90, 200 × 45 px, on v3, in a 1000 × 300 px frame)');
  assert.equal(
    commentAt({ anchor: 'region 2', region: { ...box, x: 125, w: 0, h: 0, version: 1 } }),
    '“region 2” (a point at x 125, y 90, on v1, in a 1000 × 300 px frame)',
  );
  // A named part reads as it did.
  assert.equal(commentAt({ anchor: 'chart' }), '“chart”');
});

test('#856 only an app review’s comment or thread marks a region', () => {
  const md = { id: 'r', type: 'review', version: 1, fallback: 'R', format: 'markdown', content: 'One line.' };
  const answer = buildEvent(md, 'submit', { verdict: 'comment', comments: [onBox] });
  assert.deepEqual(answer, { ok: false, error: 'Only a comment on an app marks a region.' });
  assert.equal(buildEvent({ ...md, format: 'app', appId: 'a', content: undefined }, 'submit', { verdict: 'comment', comments: [onBox] }).ok, true);
  const thread = { id: 't1', status: 'open', ...onBox, comments: [{ author: '@critic', text: 'Hm.' }] };
  delete thread.text;
  assert.match(validateBlock({ ...md, threads: [thread] }).errors.join(' '), /threads\[0\]: only an app review’s thread is on a region\./);
  assert.equal(validateBlock({ ...md, format: 'app', appId: 'a', content: undefined, threads: [thread] }).ok, true);
  assert.match(
    validateBlock({ ...md, format: 'app', appId: 'a', content: undefined, threads: [{ ...thread, region: { ...box, x: 900 } }] }).errors.join(' '),
    /threads\[0\]: a region stays inside the app/,
  );
});

test('#856 an app review’s answer with a region stores it on the thread, and the agent reads where it is', async () => {
  const s = setup();
  const shown = await turn(
    s.rt,
    s.adapter,
    s.t,
    (tools) => {
      tools.show_app({ id: 'chart', title: 'Chart', code: '<main>Chart</main>' });
      return tools.show_block({ block: { id: 'rv', type: 'review', version: 1, fallback: 'Review the chart', format: 'app', appId: 'chart' } });
    },
    '@critic show it',
  );
  assert.equal(shown.ok, true, shown.message);
  const item = () => s.store.items(s.t.id).find((i) => i.kind === 'block' && i.block.id === 'rv');
  s.rt.act(s.t.id, item().id, 'submit', { verdict: 'request_changes', comments: [onBox] }, 1);
  await settle(s.rt);
  assert.deepEqual(item().block.threads, [
    { id: 'you-1-1', status: 'open', anchor: 'region 1', region: box, comments: [{ author: 'you', text: 'This label overlaps.' }] },
  ]);
  const heard = s.adapter.calls.at(-1).message;
  assert.deepEqual(heard.event.values.comments, [{ ...onBox, threadId: 'you-1-1' }]);
  const read = s.rt.toolsFor(item().sessionId).read_message({ id: 'rv' });
  assert.match(
    read.message,
    /Comments on “region 1” \(x 120, y 90, 200 × 45 px, on v3, in a 1000 × 300 px frame\) \(open, thread you-1-1\):\n- The person: This label overlaps\./,
  );
});

test('#856 a correction of a comment on a region tells the agent the region it’s on', async () => {
  const s = setup();
  await turn(
    s.rt,
    s.adapter,
    s.t,
    (tools) => {
      tools.show_app({ id: 'chart', title: 'Chart', code: '<main>Chart</main>' });
      return tools.show_block({ block: { id: 'rv', type: 'review', version: 1, fallback: 'Review the chart', format: 'app', appId: 'chart' } });
    },
    '@critic show it',
  );
  const item = () => s.store.items(s.t.id).find((i) => i.kind === 'block' && i.block.id === 'rv');
  s.rt.act(s.t.id, item().id, 'submit', { verdict: 'request_changes', comments: [onBox] }, 1);
  await settle(s.rt);
  assert.deepEqual(s.rt.act(s.t.id, item().id, '@correct', { threadId: 'you-1-1', text: 'The label is cut off.' }), { ok: true });
  await settle(s.rt);
  const heard = s.adapter.calls.map((c) => c.message).find((m) => m.event?.action === 'correct');
  assert.deepEqual(heard?.event.values, {
    threadId: 'you-1-1',
    anchor: 'region 1',
    region: box,
    replaces: 'This label overlaps.',
    text: 'The label is cut off.',
  });
});

test('#856 the person’s region that another comment numbered first while their draft was open gets the next number', async () => {
  const s = setup();
  const theirs = { id: 'c1', status: 'open', anchor: 'region 1', region: { ...box, x: 500 }, comments: [{ author: '@critic', text: 'Mine.' }] };
  await turn(
    s.rt,
    s.adapter,
    s.t,
    (tools) => {
      tools.show_app({ id: 'chart', title: 'Chart', code: '<main>Chart</main>' });
      return tools.show_block({
        block: { id: 'rv', type: 'review', version: 1, fallback: 'Review the chart', format: 'app', appId: 'chart', threads: [theirs] },
      });
    },
    '@critic show it',
  );
  const item = () => s.store.items(s.t.id).find((i) => i.kind === 'block' && i.block.id === 'rv');
  // The person’s draft numbered its box “region 1” too, and a second comment on the same box rides with it.
  s.rt.act(s.t.id, item().id, 'submit', { verdict: 'comment', comments: [onBox, { ...onBox, text: 'And its color.' }] }, 1);
  await settle(s.rt);
  const threads = item().block.threads;
  assert.deepEqual(
    threads.map((t) => [t.anchor, t.region.x, t.comments[0].text]),
    [
      ['region 1', 500, 'Mine.'],
      ['region 2', 120, 'This label overlaps.'],
      ['region 2', 120, 'And its color.'],
    ],
  );
  assert.deepEqual(
    s.adapter.calls.at(-1).message.event.values.comments.map((c) => c.anchor),
    ['region 2', 'region 2'],
  );
});

test('#856 a region’s number past what the review holds: past every “region N”, a part of that name too', () => {
  const at = (x) => ({ ...box, x, version: 1 });
  const theirs = { anchor: 'region 1', region: at(500) };
  const oldPart = { anchor: 'region 2' };
  // Not held, or held for the same place: it keeps its number.
  assert.equal(regionAnchor({ anchor: 'region 1', region: at(100) }, []), 'region 1');
  assert.equal(regionAnchor({ anchor: 'region 1', region: at(500) }, [theirs]), 'region 1');
  // Held for another place: the next number past both the region and the part.
  const held = [theirs, oldPart];
  const r1 = { anchor: 'region 1', region: at(100) };
  assert.equal(regionAnchor(r1, held), 'region 3');
  held.push({ ...r1, anchor: 'region 3' });
  // The person’s next region, numbered 2 on their page, meets the part: it moves past the one just placed.
  assert.equal(regionAnchor({ anchor: 'region 2', region: at(300) }, held), 'region 4');
  // A second comment on the first place takes its new number.
  assert.equal(regionAnchor({ anchor: 'region 1', region: at(100) }, held), 'region 3');
  // A comment on a part is no region’s.
  assert.equal(regionAnchor({ anchor: 'region 1' }, held), 'region 1');
});
