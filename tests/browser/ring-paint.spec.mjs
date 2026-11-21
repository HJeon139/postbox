// A working agent’s ring doesn’t keep the page painting (#463, PF-2 in designs/508): Safari repainted a thinking
// ring’s SVG every frame, because each of its ~12 segments animated its own stroke-width. Chromium repaints it too, so
// its paint count stands in for Safari’s here: with one agent working, the transcript (div.main) and the rest of the
// page are painted on few of the frames over 5 s, not on each. The ring still moves, with one animation of transform
// and opacity, and with reduced motion every ring holds still.
// On a seeded conversation of 60 messages from one mock agent, marked working as #463 measured it (updateSession,
// 40% of its context): thinking, as #463 measured, and generating and calling tools, the other two working states.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('ring-paint', { demo: false });
  app.store.emit('project', { id: 'pr_paint', name: 'Paint', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** A conversation of 60 messages with one agent, open in the page, and its session. */
async function seeded(page, handle) {
  const { rt } = app;
  const p = rt.createPersona({ handle });
  const t = rt.createThread({ projectId: 'pr_paint', title: `Paint ${handle}`, personaIds: [p.id] });
  const se = arrange.agentIn(rt, t.id);
  for (let i = 0; i < 60; i++)
    arrange.post(
      rt,
      t.id,
      i % 2 ? { kind: 'agent', handle, sessionId: se.id, text: `Reply ${i}. `.repeat(20) } : { kind: 'user', text: `Message ${i}. `.repeat(20) },
    );
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  return se;
}

/** Marks the session working in state, as #463 measured it, and waits for its ring in the Agents section to say so. */
async function working(page, se, state = 'think', ctx = 40) {
  arrange.setSession(app.rt, se.id, { state, ctx, currentStep: 'Working', finishedAt: null });
  await synced(page, app);
  const ring = page.locator(`.agents-sec pb-ring[data-session="${se.id}"][state="${state}"]`);
  await expect(ring).toHaveCount(1);
  return ring;
}

/**
 * The paints Chromium records while the page draws 5 s of frames, by the node each painted, and the frames drawn. The
 * wait is the page’s own frames, not a timer.
 * @param {import('@playwright/test').Page} page
 */
async function paintsOver5s(page) {
  const cdp = await page.context().newCDPSession(page);
  /** @type {any[]} */
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  const complete = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' });
  const frames = await page.evaluate(
    () =>
      new Promise((done) => {
        const start = performance.now();
        let n = 0;
        const tick = (now) => {
          if (now - start >= 5000) return done(n);
          n++;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  await cdp.send('Tracing.end');
  await complete;
  await cdp.detach();
  const paints = events.filter((e) => e.name === 'Paint').map((e) => String(e.args?.data?.nodeName ?? ''));
  return { frames, paints, main: paints.filter((n) => n.includes("class='main'")).length };
}

/** How far the ring’s animations have run, in ms, summed: it grows while the ring moves. */
const ranFor = (ring) => ring.evaluate((el) => el.getAnimations({ subtree: true }).reduce((ms, a) => ms + Number(a.currentTime ?? 0), 0));

for (const state of ['think', 'gen', 'tool'])
  test(`PF-2: with one agent working (${state}), neither the transcript nor the page is repainted on each frame over 5 s`, async ({ page }) => {
    const se = await seeded(page, `paint-${state}`);
    const ring = await working(page, se, state);
    const before = await ranFor(ring);
    const { frames, paints, main } = await paintsOver5s(page);
    expect(frames, 'the page drew frames to count over').toBeGreaterThan(60);
    // The counts below are 0 once the ring is fixed; this says the ring was moving all the while, so 0 isn’t a ring at rest.
    expect(await ranFor(ring), 'the ring moved while the paints were counted').toBeGreaterThan(before + 4000);
    // One paint in 20 frames leaves room for a caret or a clock; a ring that repaints each frame makes it one per frame.
    expect.soft(main, `the transcript was painted ${main} times in ${frames} frames`).toBeLessThan(frames / 20);
    expect.soft(paints.length, `the page was painted ${paints.length} times in ${frames} frames`).toBeLessThan(frames / 20);
    arrange.setSession(app.rt, se.id, { state: 'idle' });
  });

test('#463: a thinking ring still moves, with one animation of transform and opacity', async ({ page }) => {
  const se = await seeded(page, 'mover');
  const ring = await working(page, se);
  const moving = await ring.evaluate((el) =>
    el.getAnimations({ subtree: true }).map((a) => ({
      state: a.playState,
      props: [...new Set(/** @type {KeyframeEffect} */ (a.effect).getKeyframes().flatMap((k) => Object.keys(k)))].filter(
        (k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k),
      ),
    })),
  );
  expect.soft(moving.length, 'the ring runs one animation, not one per segment').toBe(1);
  expect.soft(moving[0]?.state, 'and it runs').toBe('running');
  for (const m of moving)
    expect
      .soft(
        m.props.filter((p) => p !== 'transform' && p !== 'opacity'),
        'it animates only transform and opacity',
      )
      .toEqual([]);
  arrange.setSession(app.rt, se.id, { state: 'idle' });
});

// designs/intent.md, “State is shown by motion, not icons”: thinking is a short bulge of thickness running along a still
// arc. What moves is a swell, as wide as the arc at its ends and twice as wide in its middle, not a block of one width;
// on a short arc it is a round blob, as a single swollen segment was, not a spike standing across the arc.
for (const ctx of [5, 15, 40])
  test(`#1565: at ${ctx}% context, a thinking ring’s moving piece is a swell twice the arc’s width, not a block or a spike`, async ({ page }) => {
    const se = await seeded(page, `swell-${ctx}`);
    const ring = await working(page, se, 'think', ctx);
    // The outline of every shape in the moving piece, each point as its distance past the arc’s middle line and its
    // distance along the arc from the ring’s top, both in arc widths.
    const shape = await ring.evaluate((el) => {
      const arc = /** @type {SVGCircleElement} */ (el.querySelector('svg[role="img"] .arc'));
      const r = arc.r.baseVal.value;
      const sw = Number(arc.getAttribute('stroke-width'));
      const c = arc.cx.baseVal.value;
      const points = [];
      for (const piece of /** @type {NodeListOf<SVGGeometryElement>} */ (el.querySelectorAll('.mover.sweep :is(path, circle)'))) {
        const total = piece.getTotalLength();
        for (let i = 0; i < 200; i++) {
          const p = piece.getPointAtLength((i / 200) * total);
          points.push({ out: (Math.hypot(p.x - c, p.y - c) - r) / sw, along: (Math.atan2(p.x - c, c - p.y) * r) / sw });
        }
      }
      const spread = (ps, k) => (ps.length ? Math.max(...ps.map((p) => p[k])) - Math.min(...ps.map((p) => p[k])) : 0);
      return {
        widest: Math.max(...points.map((p) => p.out)),
        thick: spread(points, 'out'),
        long: spread(points, 'along'),
        wideFor: spread(
          points.filter((p) => p.out > 0.9),
          'along',
        ),
      };
    });
    expect(shape.widest, 'its middle reaches half an arc width past the arc’s edge: twice the arc’s width').toBeCloseTo(1, 1);
    expect(shape.long, `it runs along the arc at least as far as it stands across it, ${shape.thick.toFixed(2)} widths`).toBeGreaterThan(shape.thick * 0.9);
    // Long enough to taper, only its middle is that wide.
    if (ctx >= 40) expect(shape.wideFor, 'and only its middle is that wide: it tapers toward both ends').toBeLessThan(shape.long * 0.5);
    arrange.setSession(app.rt, se.id, { state: 'idle' });
  });

test('#463: with reduced motion, every ring holds still, a thinking one included', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const se = await seeded(page, 'still');
  await working(page, se);
  const running = await page.evaluate(() => [...document.querySelectorAll('pb-ring')].reduce((n, el) => n + el.getAnimations({ subtree: true }).length, 0));
  expect(running, 'no ring animates').toBe(0);
  arrange.setSession(app.rt, se.id, { state: 'idle' });
});
