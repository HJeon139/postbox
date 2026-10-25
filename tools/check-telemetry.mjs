// A headless Chrome check of the Telemetry view (designs/telemetry-persona.md, R1, R5, R18, R19): Record this room from
// the ⋯ menu, Telemetry swapping in for Work and back, a reload that keeps it, Make report with the history still
// ticked after a message, Leave out by keyboard with focus kept, Discard, Save and Delete, and File issue with no gh,
// which shows the text and its hash, then copies it and asks to open GitHub’s new-issue page. axe on each.
//
//   node tools/check-telemetry.mjs        (PB_PORT and PB_CHROME_PORT move it)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { js } from './cdp.mjs';
import { begin, check, click, conv, end, fresh, hash, ids, page, q, server, settle } from './pane-check.mjs';

// No gh, so File issue takes the copy path; and a classifier that answers at once, labeling nothing.
process.env.POSTBOX_GH_BIN = '/nonexistent/gh';
const AXE = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
await begin('check-telemetry', 4955, 10255);
server().rt.summarize = async () => ({ text: '{"labels":[]}', costUsd: 0 });

async function enter() {
  for (const type of ['keyDown', 'keyUp'])
    await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
  await settle();
}
const menuItem = (label) => `[...document.querySelectorAll('.menu [role=menuitem]')].find((b) => b.textContent.includes(${js(label)}))`;
async function menu(label) {
  await click(q('#conversation-actions'));
  await page.waitFor(menuItem(label), { label: `“${label}” in the ⋯ menu` });
  await click(menuItem(label));
  await settle();
}
const VIEW = 'aside.telemetry-view';
/** Clicks a control after scrolling it into view: the view’s lines run long. */
async function tap(expr) {
  await page.evaluate(`(${expr}).scrollIntoView({ block: 'center' })`);
  await settle();
  await click(expr);
}
const button = (text) => `[...document.querySelectorAll('${VIEW} button')].find((b) => b.textContent.includes(${js(text)}))`;
/** Whether focus is on a control in the Telemetry view, not dropped to the page. */
const focusInView = () => page.evaluate(`!!document.activeElement?.closest('${VIEW}') && /^(BUTTON|INPUT|SUMMARY)$/.test(document.activeElement.tagName)`);
const shownHash = () => page.evaluate(`(/sha256 ([0-9a-f]{64})/.exec(${q('.tv-hash')}?.textContent ?? '') ?? [])[1] ?? null`);
let axeIn = false;
async function axe(include) {
  if (!axeIn) await page.evaluate(`${AXE};0`);
  axeIn = true;
  return page.evaluate(
    `axe.run({ include: [[${js(include)}]] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }).then((r) => r.violations.map((v) => v.id + ': ' + v.help))`,
  );
}

await check('R1, R5: Record this room from the ⋯ menu; the header says so, and nothing appears in the room', async () => {
  await fresh(1440);
  const items = await page.evaluate(`document.querySelectorAll('#main .item').length`);
  await menu('Record this room');
  await page.waitFor(`/^Recording since \\d\\d:\\d\\d$/.test(${q('#recording-badge')}?.textContent ?? '')`, { label: 'the header’s badge' });
  assert.equal(await page.evaluate(`document.querySelectorAll('#main .item').length`), items);
});

await check('R18: Telemetry swaps in for Work, the Work button brings Work back, and closing Telemetry does too', async () => {
  await click(q('#work-button'));
  await page.waitFor(q('aside.workpane'), { label: 'Work' });
  await menu('Telemetry report');
  await page.waitFor(`!!${q(VIEW)} && !${q('aside.workpane')}`, { label: 'Telemetry in Work’s place' });
  assert.match(await hash(), /\?work&telemetry/);
  assert.equal(await page.evaluate(`${q('#work-button')}.getAttribute('aria-pressed')`), 'false');
  await click(q('#work-button'));
  await page.waitFor(`!!${q('aside.workpane')} && !${q(VIEW)}`, { label: 'Work back in its place' });
  assert.equal(await page.evaluate(`localStorage.getItem('pb-work-${ids.conv}')`), '1', 'Work is still remembered');
  await menu('Telemetry report');
  await click(`${q(VIEW)}.querySelector('button[aria-label="Close Telemetry"]')`);
  await page.waitFor(`!!${q('aside.workpane')} && !${q(VIEW)}`, { label: 'Work back after Close' });
});

await check('R18: a reload at ?telemetry keeps the view, with Work remembered', async () => {
  await page.evaluate(`location.hash = ${js(conv('?telemetry'))}`);
  await page.reload();
  await page.waitFor(q(VIEW), { label: 'the Telemetry view after a reload' });
  assert.match(await hash(), /telemetry/);
});

await check('R18: a message in the room leaves the history ticked; Make report; Leave out by keyboard keeps focus', async () => {
  await page.waitFor(q('#tv-history'), { label: 'the history box' });
  await click(q('#tv-history'));
  const { rt } = server();
  // A real message, so the conversation changes and its agent replies.
  rt.sendMessage(ids.conv, { text: 'One more question while the view is open.' });
  await page.waitFor(`[...document.querySelectorAll('#main .item')].some((n) => n.textContent.includes('One more question while the view is open.'))`, {
    label: 'the message in the room',
  });
  await settle();
  assert.equal(await page.evaluate(`${q('#tv-history')}.checked`), true, 'still ticked');
  await tap(button('Make report'));
  await page.waitFor(q('.tv-lines button[aria-label^="Leave out line"]'), { label: 'the report’s lines' });
  assert.ok(await focusInView(), 'focus stayed in the view through Make report');
  const before = await shownHash();
  const id = await page.evaluate(`${q('.tv-lines button[aria-label^="Leave out line"]')}.id`);
  await page.evaluate(`document.getElementById(${js(id)}).focus()`);
  await enter();
  await page.waitFor(`(/sha256 ([0-9a-f]{64})/.exec(${q('.tv-hash')}?.textContent ?? '') ?? [])[1] !== ${js(before)}`, { label: 'the new hash' });
  assert.equal(await page.evaluate('document.activeElement.id'), id, 'focus stayed on the toggle');
  assert.equal(await page.evaluate(`document.getElementById(${js(id)}).getAttribute('aria-pressed')`), 'true');
  assert.match(await page.evaluate(`document.getElementById(${js(id)}).getAttribute('aria-label')`), /^Leave out line \d+$/, 'one name');
  assert.deepEqual(await axe(VIEW), []);
});

await check('R18: Discard drops the draft; a new one saves, lists itself, reopens read-only, and its Delete removes it', async () => {
  await tap(button('Discard'));
  await page.waitFor(button('Make report'), { label: 'Make report again' });
  assert.ok(await focusInView(), 'focus stayed in the view after Discard');
  const { rt, store } = server();
  const reply = store.items(ids.conv).find((i) => i.kind === 'agent');
  rt.act(ids.conv, reply.id, '@react', { emoji: '🚩' });
  await tap(button('Make report'));
  await page.waitFor(q('.tv-lines'), { label: 'the report' });
  await tap(button('Save report'));
  await page.waitFor(q('.tv-saved'), { label: 'the saved report' });
  assert.ok(await focusInView(), 'focus stayed in the view after Save');
  await tap(`${q('.tv-saved details summary')}`);
  await page.waitFor(`(${q('.tv-saved details pre')}?.textContent ?? '').includes('postbox-telemetry-2')`, { label: 'the saved bytes' });
  assert.deepEqual(await axe(VIEW), []);
});

await check('R19: File issue with no gh shows the text and its hash, then copies it and asks for the new-issue page', async () => {
  await page.evaluate(`(() => { window.__opened = []; window.__copied = []; window.open = (u) => { window.__opened.push(String(u)); return null; };
    if (navigator.clipboard) navigator.clipboard.writeText = (t) => { window.__copied.push(String(t)); return Promise.resolve(); }; })()`);
  await tap(`${q('.tv-saved .tv-findings button')}`);
  await page.waitFor(q('.dialog pre.tv-issue'), { label: 'the issue’s text' });
  const shown = await page.evaluate(`${q('.dialog pre.tv-issue')}.textContent`);
  assert.match(await page.evaluate(`${q('.dialog .d-body')}.textContent`), /sha256 [0-9a-f]{64}/);
  assert.deepEqual(await axe('.dialog'), []);
  await click(`[...document.querySelectorAll('.dialog .d-foot button')].find((b) => b.textContent === 'Send')`);
  await page.waitFor('window.__opened.length > 0', { label: 'the new-issue page asked for' });
  assert.deepEqual(await page.evaluate('window.__opened'), ['https://github.com/HJeon139/postbox/issues/new']);
  assert.deepEqual(await page.evaluate('window.__copied'), [shown]);
  await tap(`[...document.querySelectorAll('${VIEW} .tv-saved button')].find((b) => b.textContent === 'Delete report')`);
  await page.waitFor(`!${q('.tv-saved')}`, { label: 'the report deleted' });
});

await check('R5: the header’s badge adds no listener that stays, on the Threads page or a conversation', async () => {
  const { rt, store } = server();
  const listeners = () => page.evaluate(`import('/app/js/client.mjs').then((m) => m.client.listeners.size)`);
  const churn = async () => {
    const t = store.state.threads[ids.other];
    for (let i = 0; i < 10; i++) rt.putThread({ ...t, title: `${t.title} ${i}` });
    rt.putThread(t);
    await settle();
  };
  await page.evaluate(`location.hash = '#/p/${store.state.threads[ids.conv].projectId}/threads'`);
  await settle();
  const threads = await listeners();
  await churn();
  assert.ok((await listeners()) <= threads, 'the Threads page');
  await page.evaluate(`location.hash = ${js(conv(''))}`);
  await page.waitFor(q('#recording-badge'), { label: 'the conversation’s badge' });
  const here = await listeners();
  await churn();
  assert.ok((await listeners()) <= here, 'the conversation');
});

await end();
