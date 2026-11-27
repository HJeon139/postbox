// A comment on a region of an app (#856): the person clicks a point or drags a box on the app in its review, and the
// comment carries it as fractions of the app’s width and height, with the app version it was made on. The shared rule
// checks it wherever a comment enters, and the agent reads it with the comment.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBlock } from '../shared/catalog.mjs';
import { buildEvent } from '../shared/events.mjs';
import { commentAt, commentErrors } from '../shared/review-comments.mjs';
import { settle, setup, turn } from './blocks-fixture.mjs';

const box = { x: 0.12, y: 0.3, w: 0.2, h: 0.15, version: 3 };
const onBox = { anchor: 'region 1', region: box, text: 'This label overlaps.' };

test('#856 a comment on a box or a point of an app is a comment', () => {
  assert.deepEqual(commentErrors(onBox, 'c'), []);
  assert.deepEqual(commentErrors({ anchor: 'region 2', region: { x: 0.5, y: 0.5, w: 0, h: 0, version: 1 }, text: 'Here.' }, 'c'), []);
  // A box to the app’s right and bottom edges, which floating point sums to a hair past 1.
  assert.deepEqual(commentErrors({ anchor: 'region 3', region: { x: 0.7, y: 0.9, w: 0.3, h: 0.1, version: 1 }, text: 'Edge.' }, 'c'), []);
});

test('#856 a region’s x, y, w and h are fractions from 0 to 1', () => {
  for (const [k, v] of [
    ['x', -0.1],
    ['y', 1.5],
    ['w', 2],
    ['h', '0.1'],
  ])
    assert.deepEqual(commentErrors({ ...onBox, region: { ...box, [k]: v } }, 'c'), [
      `c.region.${k} must be a number from 0 to 1, a fraction of the app’s size.`,
    ]);
});

test('#856 a region stays inside the app: x + w and y + h are at most 1', () => {
  const why = ['c: a region stays inside the app: x + w and y + h are at most 1.'];
  assert.deepEqual(commentErrors({ ...onBox, region: { ...box, x: 0.9, w: 0.2 } }, 'c'), why);
  assert.deepEqual(commentErrors({ ...onBox, region: { ...box, y: 0.9, h: 0.2 } }, 'c'), why);
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
    'c: “region 1” names a marked region, so it needs its region: { x, y, w, h, version }.',
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
  const clash = validateBlock({ ...app, threads: [thread('t1', box), thread('t2', { ...box, x: 0.5 })] });
  assert.equal(clash.ok, false);
  assert.match(clash.errors.join(' '), /threads\[1\]: “region 1” is already threads\[0\]’s region; give this one the next number\./);
  // Two threads on the same region, such as a reply in a new thread, are fine.
  assert.equal(validateBlock({ ...app, threads: [thread('t1', box), thread('t2', box)] }).ok, true);
});

test('#856 the agent reads a region with its place, its size and its version, and a point as a point', () => {
  assert.equal(commentAt(onBox), '“region 1” (x 12%, y 30%, 20% × 15%, on v3)');
  assert.equal(commentAt({ anchor: 'region 2', region: { x: 0.125, y: 0.3, w: 0, h: 0, version: 1 } }), '“region 2” (a point at x 12.5%, y 30%, on v1)');
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
    validateBlock({ ...md, format: 'app', appId: 'a', content: undefined, threads: [{ ...thread, region: { ...box, x: 0.9 } }] }).errors.join(' '),
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
  assert.match(read.message, /Comments on “region 1” \(x 12%, y 30%, 20% × 15%, on v3\) \(open, thread you-1-1\):\n- The person: This label overlaps\./);
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
  const theirs = { id: 'c1', status: 'open', anchor: 'region 1', region: { ...box, x: 0.5 }, comments: [{ author: '@critic', text: 'Mine.' }] };
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
      ['region 1', 0.5, 'Mine.'],
      ['region 2', 0.12, 'This label overlaps.'],
      ['region 2', 0.12, 'And its color.'],
    ],
  );
  assert.deepEqual(
    s.adapter.calls.at(-1).message.event.values.comments.map((c) => c.anchor),
    ['region 2', 'region 2'],
  );
});
