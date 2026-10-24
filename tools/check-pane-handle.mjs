// A headless Chrome check of the right pane’s handle (#86): it resizes the pane by keyboard, drag and double-click,
// within the conversation column’s minimum, with axe clean on it, and its width survives a reload; a classic scroll
// bar doesn’t take the column’s room (#197); and a thread left open in a conversation opens again when you come back
// (#122).
//
//   node tools/check-pane-handle.mjs        (PB_PORT and PB_CHROME_PORT move it)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { BOX_MIN, begin, COL_MIN, check, click, conv, end, fresh, has, hash, ids, measure, open, page, press, q, settle, THREAD, WORK } from './pane-check.mjs';

const AXE = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
await begin('check-pane-handle', 4952, 10252);
const { topic, other } = ids;

// ── #86: a handle on the pane’s edge ───────────────────────────────────────────────────

const handle = (attr) => page.evaluate(`${q('.rp-handle')}.getAttribute(${JSON.stringify(attr)})`);
/** Drags the handle to x, as a person does: press, two moves, release. */
async function drag(x, clicks = 0) {
  const b = await page.evaluate(`(() => { const r = ${q('.rp-handle')}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
  if (clicks) {
    for (const clickCount of [1, 2])
      for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount });
    return settle();
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  for (const to of [b.x - 20, x]) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to, y: b.y, button: 'left', buttons: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: b.y, button: 'left', clickCount: 1 });
  await settle();
}

await check('#86 the pane’s handle resizes it by keyboard, within the column’s minimum, and the app resizes with it', async () => {
  await fresh(1280);
  await click(q('#work-button'));
  await page.waitFor(`${q(WORK)} && ${q('.transcript .appframe iframe')}`, { label: 'Work, beside the app' });
  assert.deepEqual(
    [await handle('role'), await handle('aria-label'), await handle('aria-valuenow'), await handle('aria-valuemin'), await handle('aria-valuemax')],
    ['separator', 'Resize the pane', '440', '320', String(1280 - COL_MIN)],
  );
  const before = await measure();
  await page.evaluate(`${q('.rp-handle')}.focus()`);
  await press('ArrowLeft', 'ArrowLeft', 37);
  await press('ArrowLeft', 'ArrowLeft', 37);
  const wider = await measure();
  assert.deepEqual([await handle('aria-valuenow'), wider.pane], ['472', 472]);
  assert.equal(wider.app, before.app - 32, 'the app didn’t resize with the pane');
  // End takes it as wide as the column’s minimum allows, Home to its own minimum.
  await press('End', 'End', 35);
  assert.deepEqual([(await measure()).pane, (await measure()).main], [1280 - COL_MIN, COL_MIN]);
  await press('Home', 'Home', 36);
  assert.equal((await measure()).pane, 320);
  // axe finds nothing wrong with it.
  await page.evaluate(`${AXE};0`);
  const bad = await page.evaluate(`axe.run({ include: [['.rp-handle']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
    .then((r) => r.violations.map((v) => v.id + ': ' + v.help))`);
  assert.deepEqual(bad, []);
});

await check('#86 a drag resizes the pane, its width survives a reload, and a double-click puts it back', async () => {
  await fresh(1280);
  await click(q('#work-button'));
  await page.waitFor(q(WORK), { label: 'Work' });
  await drag(1280 - 520);
  assert.equal((await measure()).pane, 520);
  await page.reload();
  await page.waitFor(q(WORK), { label: 'Work, after the reload' });
  await settle();
  assert.deepEqual([await handle('aria-valuenow'), (await measure()).pane], ['520', 520]);
  await drag(0, 2);
  assert.deepEqual([await handle('aria-valuenow'), (await measure()).pane], ['440', 440]);
  // At 375 px the pane covers the conversation, so it has no handle to show.
  await page.size(375, 812);
  await page.waitFor(`innerWidth === 375 && !${q('.rp-handle')}.getClientRects().length`, { label: 'no handle at 375 px' });
});

await check('#197 a classic scroll bar doesn’t take the column’s room, and a drag follows the pointer beside it', async () => {
  await fresh(985);
  // Windows, Linux, and macOS set to always show scroll bars give the page’s scroll bar 15 px of the window, which
  // innerWidth counts. Headless Chrome hides scroll bars (--hide-scrollbars, which nothing in the page undoes), so the
  // window reports those 15 px here instead.
  await page.evaluate(`Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => 1000 }), 0`);
  try {
    await click(q('#work-button'));
    await page.waitFor(q(WORK), { label: 'Work' });
    const m = await measure();
    assert.ok(m.main >= COL_MIN && m.box >= BOX_MIN, `the column is ${m.main} px and the text box ${m.box} px`);
    assert.equal(m.pane, 985 - COL_MIN);
    await drag(985 - 330);
    assert.equal((await measure()).pane, 330, 'the pane’s edge isn’t under the pointer');
  } finally {
    await page.reload();
  }
});

// ── #122: a thread left open opens again ──────────────────────────────────────────────

await check('#122 a thread left open in a conversation opens again when you come back, until you close it', async () => {
  await fresh(1280);
  await open(conv(`/side/${topic}`));
  await page.waitFor(q(THREAD), { label: 'the thread' });
  await open(`#/t/${other}`);
  await page.waitFor(`location.hash === ${JSON.stringify(`#/t/${other}`)} && ${q('.rpane[hidden]')}`, { label: 'the other conversation, alone' });
  await open(conv(''));
  await page.waitFor(q(THREAD), { label: 'the thread, open again' });
  assert.equal(await hash(), conv(`/side/${topic}`));
  // Closed, it stays closed.
  await click(`${q(THREAD)}.querySelector('button[aria-label="Close thread"]')`);
  await page.waitFor(q('.rpane[hidden]'), { label: 'the thread to close' });
  assert.equal(await hash(), conv(''));
  await open(`#/t/${other}`);
  await open(conv(''));
  assert.deepEqual([await hash(), await has(THREAD)], [conv(''), false]);
});

await check('#122 in a window with no room for the pane, coming back opens the conversation, not the thread over it', async () => {
  await fresh(800);
  await open(conv(`/side/${topic}`));
  await page.waitFor(q('.sidepanel.pane-full'), { label: 'the thread, full screen' });
  await open(`#/t/${other}`);
  await open(conv(''));
  assert.deepEqual([await hash(), await has(THREAD)], [conv(''), false]);
});

await end();
