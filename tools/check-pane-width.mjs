// A headless Chrome check of how the right pane shares the window with the conversation, at 800, 1024 and 1280 px
// with the sidebar open: the column and the composer’s text box keep their minimums or the view opens full screen,
// and a wider window puts the pane back (#197); and the sidebar hides first, while the pane needs its room (#7).
// tools/check-pane-handle.mjs checks the pane’s handle (#86) and a thread left open (#122).
//
//   node tools/check-pane-width.mjs        (PB_PORT and PB_CHROME_PORT move it)

import assert from 'node:assert/strict';
import { BOX_MIN, begin, COL_MIN, check, click, conv, end, fresh, has, hash, ids, measure, open, page, press, q, settle, THREAD, WORK } from './pane-check.mjs';

await begin('check-pane-width', 4950, 10250);
const { topic, other } = ids;

// ── #197: the column keeps its minimum, or the view opens full screen ──────────────────

for (const [view, how] of [
  ['Work', () => click(q('#work-button'))],
  ['the thread', () => open(conv(`/side/${topic}`))],
])
  for (const width of [800, 1024, 1280])
    await check(`#197 at ${width} px with the sidebar open, ${view} leaves the column and the text box usable, or opens full screen`, async () => {
      await fresh(width);
      const before = await measure();
      await how();
      await page.waitFor(view === 'Work' ? q(WORK) : q(THREAD), { label: view });
      await settle();
      const m = await measure();
      const kept = m.main >= COL_MIN && m.box >= BOX_MIN && m.pane >= 320;
      assert.ok(
        m.full || kept,
        `the column is ${m.main} px (a reply ${m.reply} px), the text box ${m.box} px, the pane ${m.pane} px, and nothing is full screen`,
      );
      if (!m.full) return;
      // Full screen, the view is the window and a dialog, and the address still says only what’s open.
      assert.ok(m.focusIn, 'focus isn’t in the full-screen view');
      assert.doesNotMatch(await hash(), /full=/);
      // Its icon goes back to the conversation, since there’s no pane to go back to, and says so.
      assert.equal(await page.evaluate(`document.querySelector('.pane-full .btn[id$="-full"]').getAttribute('aria-label')`), 'Back to the conversation');
      // Escape brings the conversation back.
      await press('Escape', 'Escape', 27);
      await page.waitFor(`!${q('.pane-full')} && ${q('.rpane[hidden]')}`, { label: 'the conversation, with the pane closed' });
      assert.equal(await hash(), conv(''));
      const back = await measure();
      assert.deepEqual([back.main, back.box], [before.main, before.box], 'the conversation didn’t come back as it was');
    });

await check('#197 a wider window puts the pane back beside the conversation, since what’s open stays in the address', async () => {
  await fresh(800);
  await click(q('#work-button'));
  await page.waitFor(q('.workpane.pane-full'), { label: 'Work full screen at 800 px' });
  assert.equal(await hash(), conv('?work'));
  await page.size(1440, 800);
  await page.waitFor(`!${q('.pane-full')} && ${q(WORK)}`, { label: 'Work beside the conversation at 1440 px' });
  const m = await measure();
  assert.ok(m.main >= COL_MIN && m.pane >= 320, `the column is ${m.main} px and the pane ${m.pane} px`);
  // And narrower again, full screen again.
  await page.size(800, 800);
  await page.waitFor(q('.workpane.pane-full'), { label: 'Work full screen again at 800 px' });
  assert.equal(await has(`${WORK}:not(.pane-full)`), false);
});

// ── #7: the sidebar hides first, while the pane needs its room ─────────────────────────

await check('#7 at 1280 px, a thread hides the sidebar while it’s open, so an app keeps its room, and closing it brings the sidebar back', async () => {
  await fresh(1280);
  await page.waitFor(q('.transcript .appframe iframe'), { label: 'the app' });
  const before = await measure();
  assert.equal(before.rail, 248);
  await open(conv(`/side/${topic}`));
  await page.waitFor(q(THREAD), { label: 'the thread' });
  const m = await measure();
  assert.deepEqual([m.rail, m.auto, m.pane, m.toggle], [0, true, 440, 'Show the sidebar'], 'the sidebar didn’t hide for the pane');
  // #7 measured an app at about 590 px beside the pane with the sidebar open.
  assert.ok(m.app > 700, `the app is ${m.app} px`);
  await click(`${q(THREAD)}.querySelector('button[aria-label="Close thread"]')`);
  await page.waitFor(q('.rpane[hidden]'), { label: 'the thread to close' });
  const back = await measure();
  assert.deepEqual([back.rail, back.auto, back.toggle, back.app], [248, false, 'Hide the sidebar', before.app], 'the sidebar didn’t come back');
  assert.equal(await page.evaluate(`localStorage.getItem('pb-rail')`), null, 'it changed what the person chose');
});

await check('#7 showing the sidebar again while the pane is open keeps it, and the pane makes do with what’s left', async () => {
  await fresh(1280);
  await click(q('#work-button'));
  await page.waitFor(`${q(WORK)} && ${q('.app.rail-auto')}`, { label: 'Work, with the sidebar hidden' });
  await click(q('#rail-toggle'));
  await page.waitFor(`!${q('.app.rail-auto')}`, { label: 'the sidebar back' });
  const m = await measure();
  assert.deepEqual([m.rail, m.toggle, m.full], [248, 'Hide the sidebar', false]);
  assert.ok(m.main >= COL_MIN && m.pane === 1280 - 248 - COL_MIN, `the column is ${m.main} px and the pane ${m.pane} px`);
});

await check('#7 from a sidebar the person hid, showing it while the pane is open shows it at once, and keeps it', async () => {
  await fresh(1280, { railHidden: true });
  await click(q('#work-button'));
  await page.waitFor(q(WORK), { label: 'Work' });
  assert.equal((await measure()).rail, 0);
  await click(q('#rail-toggle'));
  const m = await measure();
  assert.deepEqual([m.rail, m.auto, m.toggle], [248, false, 'Hide the sidebar'], 'one press didn’t show the sidebar');
  assert.ok(m.main >= COL_MIN && m.pane === 1280 - 248 - COL_MIN, `the column is ${m.main} px and the pane ${m.pane} px`);
  assert.equal(await page.evaluate(`localStorage.getItem('pb-rail')`), 'shown');
});

for (const railHidden of [false, true])
  await check(
    `#7 where the pane wouldn’t fit beside the sidebar${railHidden ? ' the person hid' : ''}, the button says it can’t show it, and changes nothing`,
    async () => {
      await fresh(1024, { railHidden });
      await click(q('#work-button'));
      await page.waitFor(q(WORK), { label: 'Work' });
      assert.equal(await page.evaluate(`${q('#rail-toggle')}.getAttribute('aria-disabled')`), 'true');
      await click(q('#rail-toggle'));
      await page.waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('No room for the sidebar beside the pane'))`, {
        label: 'why it can’t show',
      });
      const m = await measure();
      assert.deepEqual([m.full, m.rail, m.toggle], [false, 0, 'Show the sidebar'], 'the pane went full screen, or the sidebar showed over it');
      assert.ok(m.main >= COL_MIN, `the column is ${m.main} px`);
      assert.equal(await page.evaluate(`localStorage.getItem('pb-rail')`), railHidden ? 'hidden' : null, 'it changed what the person chose');
    },
  );

await check('#7 leaving a conversation whose pane hid the sidebar, the next one shows it, and its button says so', async () => {
  await fresh(1280);
  await open(conv(`/side/${topic}`));
  await page.waitFor(`${q(THREAD)} && ${q('.app.rail-auto')}`, { label: 'the thread, with the sidebar hidden' });
  await open(`#/t/${other}`);
  await page.waitFor(`location.hash === ${JSON.stringify(`#/t/${other}`)}`, { label: 'the other conversation' });
  const m = await measure();
  const pressed = await page.evaluate(`${q('#rail-toggle')}.getAttribute('aria-pressed')`);
  assert.deepEqual([m.rail, m.toggle, pressed], [248, 'Hide the sidebar', 'true']);
});

await end();
