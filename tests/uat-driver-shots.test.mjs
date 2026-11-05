// keepView (tools/uat/driver-shots.mjs, #531): a screenshot the runner takes leaves the person’s view as it was. Run
// against a stand-in page whose transcripts publish their view as app/js/view-state.mjs does, and hear a scroll only
// in the next frame, as a browser does.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { keepView } from '../tools/uat/driver-shots.mjs';

/** The page’s frames: a scroll is heard in the next one, before that frame’s animation callbacks. */
function clock() {
  /** @type {Set<any>} */
  const scrolled = new Set();
  /** @type {(() => void)[]} */
  let callbacks = [];
  let ticking = false;
  const frame = () => {
    ticking = false;
    const heard = [...scrolled];
    scrolled.clear();
    const now = callbacks;
    callbacks = [];
    for (const t of heard) t.publish();
    for (const cb of now) cb();
  };
  const tick = () => {
    if (!ticking) setImmediate(frame);
    ticking = true;
  };
  return {
    scroll: (t) => {
      scrolled.add(t);
      tick();
    },
    requestAnimationFrame: (cb) => {
      callbacks.push(cb);
      tick();
    },
  };
}

/** A transcript’s scroll box, `height` tall and `top` down the window, over content `total()` tall. */
function scrollBox({ height, top, total, heard }) {
  let scrollTop = 0;
  const box = {
    clientHeight: height,
    get scrollHeight() {
      return Math.max(total(), height);
    },
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(y) {
      const next = Math.min(Math.max(0, y), box.scrollHeight - height);
      if (next === scrollTop) return;
      scrollTop = next;
      heard();
    },
    scrollTo: ({ top: y }) => {
      box.scrollTop = y;
    },
    scrollBy: ({ top: dy }) => {
      box.scrollTop = scrollTop + dy;
    },
    getBoundingClientRect: () => ({ top }),
  };
  return box;
}

/**
 * A transcript of stacked items in its box. Once a scroll is heard it publishes as view-state.mjs does: following
 * within 2 px of the end, else reading at the item across the middle of the view, by how far down the view it starts,
 * to 0.1 px. It starts at the end.
 * @param {ReturnType<typeof clock>} frames @param {string} where @param {number[]} heights
 * @param {{ height?: number, top?: number }} [o]
 */
function transcript(frames, where, heights, { height = 400, top = 0 } = {}) {
  const items = heights.map((h, i) => ({ key: `it_${where}${i}`, h }));
  const yOf = (it) => items.slice(0, items.indexOf(it)).reduce((s, x) => s + x.h, 0);
  const box = scrollBox({ height, top, total: () => items.reduce((s, it) => s + it.h, 0), heard: () => frames.scroll(t) });
  const rect = (it) => ({ top: top + yOf(it) - box.scrollTop, bottom: top + yOf(it) + it.h - box.scrollTop });
  const el = {
    dataset: {},
    parentElement: box,
    querySelector(sel) {
      const it = items.find((x) => x.key === /data-key="([^"]+)"/.exec(sel)?.[1]);
      return it ? { getBoundingClientRect: () => rect(it) } : null;
    },
  };
  const t = {
    el,
    box,
    items,
    /** Where an item starts in the view. */
    at: (i) => rect(items[i]).top - top,
    publish() {
      const reading = box.scrollHeight - box.scrollTop - height > 2;
      const anchor = reading ? items.find((it) => rect(it).bottom - top > height / 2) : null;
      el.dataset.viewMode = reading ? 'reading' : 'following';
      el.dataset.viewAnchor = anchor?.key ?? '';
      el.dataset.viewOffset = anchor ? String(Math.round((rect(anchor).top - top) * 10) / 10) : '';
    },
  };
  box.scrollTop = box.scrollHeight;
  t.publish();
  return t;
}

/** A page with the conversation’s transcript, scrolling the window, and the panel’s, scrolling its own box. */
function standIn() {
  const frames = clock();
  /** @type {Record<string, any>} */
  const views = {};
  const ctx = {
    CSS: { escape: (s) => s },
    requestAnimationFrame: frames.requestAnimationFrame,
    document: {
      get scrollingElement() {
        return views.main?.box ?? null;
      },
      querySelector: (sel) => ({ '#main.transcript': views.main?.el, '.sidepanel .transcript': views.panel?.el })[sel] ?? null,
    },
  };
  return {
    transcript: (where, heights, o) => {
      views[where] = transcript(frames, where, heights, o);
      return views[where];
    },
    // page.evaluate hands back a copy, as JSON, so the stand-in does too.
    ev: async (expr) => {
      const r = await runInNewContext(expr, ctx);
      return r === undefined ? undefined : JSON.parse(JSON.stringify(r));
    },
    /** Until the page has heard every scroll so far. */
    frames: () => new Promise((r) => frames.requestAnimationFrame(() => frames.requestAnimationFrame(r))),
  };
}

const HEIGHTS = Array.from({ length: 20 }, () => 150);
/** keepView with what it records. */
const keeping = (page, fn) => {
  const moved = [];
  return { moved, run: keepView(page.ev, fn, (m) => moved.push(m)) };
};
const mode = (t) => t.el.dataset.viewMode;

for (const where of /** @type {const} */ (['main', 'panel'])) {
  const top = where === 'panel' ? 120 : 0;

  test(`a ${where} view that was following is back at the end after a capture that throws, with a reply in during it`, async () => {
    const page = standIn();
    const t = page.transcript(where, HEIGHTS, { top });
    const { moved, run } = keeping(page, async () => {
      t.box.scrollTop = 300;
      await page.frames();
      assert.equal(mode(t), 'reading', 'the shot scrolled the view up');
      t.items.push({ key: `it_${where}_new`, h: 400 });
      throw new Error('The capture failed.');
    });
    await assert.rejects(run, /The capture failed\./);
    assert.equal(mode(t), 'following');
    assert.equal(t.box.scrollHeight - t.box.scrollTop - t.box.clientHeight, 0, 'at the new end');
    assert.deepEqual(moved, []);
  });

  test(`a ${where} view that was reading has its anchor back at its offset, by its key, after what’s above it grew`, async () => {
    const page = standIn();
    const t = page.transcript(where, HEIGHTS, { top });
    t.box.scrollTop = 1234.5;
    await page.frames();
    const before = { ...t.el.dataset };
    assert.equal(before.viewMode, 'reading');
    const { moved, run } = keeping(page, async () => {
      t.box.scrollTop = 100;
      await page.frames();
      t.items[0].h += 120;
      return 'shot.png';
    });
    assert.equal(await run, 'shot.png');
    assert.deepEqual({ ...t.el.dataset }, before, 'the same mode, anchor and offset, as the page publishes them once it has settled');
    const i = t.items.findIndex((it) => it.key === before.viewAnchor);
    assert.ok(Math.abs(t.at(i) - Number(before.viewOffset)) <= 1, 'the anchor starts where it did');
    assert.deepEqual(moved, []);
  });
}

test('both transcripts are put back, each in its own box: the conversation reading and the panel following', async () => {
  const page = standIn();
  const main = page.transcript('main', HEIGHTS);
  const panel = page.transcript('panel', HEIGHTS, { top: 120 });
  main.box.scrollTop = 900;
  await page.frames();
  const before = { ...main.el.dataset };
  const { moved, run } = keeping(page, async () => {
    main.box.scrollTop = 0;
    panel.box.scrollTop = 0;
    await page.frames();
  });
  await run;
  assert.deepEqual({ ...main.el.dataset }, before);
  assert.equal(mode(panel), 'following');
  assert.deepEqual(moved, []);
});

test('a reading view put back within 2 px of the end comes back following, and that is accepted', async () => {
  const page = standIn();
  const t = page.transcript('main', HEIGHTS);
  // 3 px above the end: reading.
  t.box.scrollTop = t.box.scrollHeight - t.box.clientHeight - 3;
  await page.frames();
  assert.equal(mode(t), 'reading');
  const { moved, run } = keeping(page, async () => {
    t.box.scrollTop = 0;
    await page.frames();
    // What’s below the anchor got 2 px shorter, so its place is now 1 px from the end.
    t.items.at(-1).h -= 2;
  });
  await run;
  assert.equal(mode(t), 'following');
  assert.deepEqual(moved, []);
});

test('a reading view that lands following but with its anchor moved more than 2 px is recorded as the runner’s', async () => {
  const page = standIn();
  const t = page.transcript('main', HEIGHTS);
  t.box.scrollTop = t.box.scrollHeight - t.box.clientHeight - 3;
  await page.frames();
  const before = { ...t.el.dataset };
  const { moved, run } = keeping(page, async () => {
    t.box.scrollTop = 0;
    await page.frames();
    // The end came up 60 px: the anchor can’t be put back where it was.
    t.items.at(-1).h -= 60;
  });
  await run;
  assert.equal(mode(t), 'following');
  assert.equal(moved.length, 1);
  assert.equal(moved[0].where, 'main');
  assert.equal(moved[0].before.anchor, before.viewAnchor);
  assert.equal(moved[0].after.mode, 'following');
});

test('a reading view that comes back reading at another anchor is recorded as the runner’s', async () => {
  const page = standIn();
  const t = page.transcript('main', HEIGHTS);
  t.box.scrollTop = 1500;
  await page.frames();
  const { moved, run } = keeping(page, async () => {
    t.box.scrollTop = 0;
    await page.frames();
    // Everything above the anchor goes, so the box can’t scroll far enough to put it back.
    for (let i = 0; i < 11; i++) t.items[i].h = 0;
  });
  await run;
  assert.equal(moved.length, 1);
  assert.equal(moved[0].after.mode, 'reading');
});

test('an anchor that’s gone leaves the view where it is, and isn’t blamed on the runner', async () => {
  const page = standIn();
  const t = page.transcript('main', HEIGHTS);
  t.box.scrollTop = 1500;
  await page.frames();
  const anchor = t.el.dataset.viewAnchor;
  const { moved, run } = keeping(page, async () => {
    t.box.scrollTop = 600;
    await page.frames();
    t.items.splice(
      t.items.findIndex((it) => it.key === anchor),
      1,
    );
  });
  await run;
  assert.equal(t.box.scrollTop, 600, 'left where the shot put it');
  assert.deepEqual(moved, []);
});
