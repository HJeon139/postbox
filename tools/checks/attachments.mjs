// Headless check for image attachments and dropping files (#48):
//   - an image the server shows inline (PNG) gets a thumbnail served by /api/files, which opens the full image by keyboard;
//   - an image the server doesn’t show inline (SVG) keeps the file chip;
//   - a file dropped on a topic thread’s panel attaches to the panel’s composer, not the conversation’s;
//   - a file dropped on the conversation, with the panel open, still attaches to the conversation’s composer.
//
//   node tools/checks/attachments.mjs
//
// Drops are synthetic DragEvents carrying a real DataTransfer with a File, dispatched with Runtime.evaluate on the
// element under the point a person would drop on. They bubble through the real DOM to the app’s own listeners, which
// then upload through the app’s own path (POST /api/files). CDP’s Input.dispatchDragEvent needs files on disk and
// a drag started by the browser; the synthetic events exercise the same handlers without either.
//
// It starts its own Postbox on port 4430 and Chrome on port 9630, and fails fast if either port is taken.

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../server/index.mjs';
import { launch, sleep } from '../cdp.mjs';
import { pageCookie } from '../demo.mjs';

const PORT = Number(process.env.PB_PORT ?? 4430);
const CHROME_PORT = Number(process.env.PB_CHROME_PORT ?? 9630);

const portFree = (port) =>
  new Promise((ok) => {
    const s = createServer()
      .once('error', () => ok(false))
      .once('listening', () => s.close(() => ok(true)))
      .listen(port, '127.0.0.1');
  });

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`);
};

for (const p of [PORT, CHROME_PORT])
  if (!(await portFree(p))) {
    console.log(`FAIL port ${p} is in use; stop whatever is on it first`);
    process.exit(1);
  }

const origin = `http://127.0.0.1:${PORT}`;
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-attachments-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
let page;

/** Runs in the page: builds a file and drops it on the element at the center of `selector`. */
const DROP = `window.__drop = async (selector, kind, name) => {
  let file;
  if (kind === 'png') {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    const g = c.getContext('2d');
    g.fillStyle = 'orange';
    g.fillRect(0, 0, 64, 48);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    file = new File([blob], name, { type: 'image/png' });
  } else {
    file = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'], name, { type: 'image/svg+xml' });
  }
  const box = document.querySelector(selector).getBoundingClientRect();
  const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  const dt = new DataTransfer();
  dt.items.add(file);
  const fire = (type) => !target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  return { allowed: fire('dragover'), taken: fire('drop') };
};`;

const chips = (scope) => `[...document.querySelectorAll(${JSON.stringify(`${scope} .composer .attachments .att`)})].map((n) => n.textContent)`;

try {
  page = await launch({ port: CHROME_PORT });
  await page.size(1280, 900, { theme: 'light' });

  // A conversation with a message to start a topic thread from.
  // Writes need the page’s token (#74), which loading the page gives.
  const cookie = await pageCookie(origin);
  const post = (path, body) =>
    fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) }).then((r) => r.json());
  const st = await (await fetch(`${origin}/api/state`)).json();
  const conv = Object.values(st.state.threads).find((t) => t.title === 'Corpus explorer');
  const msg = await post(`/api/threads/${conv.id}/messages`, { text: 'Start a thread from here.' });
  const after = await (await fetch(`${origin}/api/state`)).json();
  const rootId = msg.item?.id ?? after.state.items[conv.id].findLast((i) => i.kind === 'user').id;
  const { threadId: topicId } = await post(`/api/threads/${conv.id}/items/${rootId}/topic`, {});

  // 1 · An inline image gets a thumbnail; an SVG keeps the file chip.
  await page.goto(`${origin}/#/t/${conv.id}`);
  await page.waitFor(`!!document.getElementById('composer-input')`, { label: 'the composer' });
  await page.evaluate(DROP);
  const png = await page.evaluate(`window.__drop('.main .transcript', 'png', 'shot.png')`);
  check('a drop on the conversation is allowed and taken', png.allowed && png.taken, JSON.stringify(png));
  await page.evaluate(`window.__drop('.main .transcript', 'svg', 'diagram.svg')`);
  await page
    .waitFor(`${chips('.main')}.length === 2 && !${chips('.main')}.some((t) => t.includes('uploading'))`, { label: 'both files uploaded' })
    .catch(() => {});
  check('both files attach to the conversation’s composer', (await page.evaluate(`${chips('.main')}.length`)) === 2);
  // Send once the agent has finished replying to the first message (Stop replaces Send while it works).
  await page.waitFor(`!!document.querySelector('.main .composer button.send')`, { label: 'the Send button', timeout: 60000 });
  await page.evaluate(`document.querySelector('.main .composer button.send').click()`);
  await page
    .waitFor(`[...document.querySelectorAll('.transcript .me-card .attachments')].some((n) => n.textContent.includes('diagram.svg'))`, {
      label: 'the sent message',
    })
    .catch(() => {});
  const sent = `[...document.querySelectorAll('.transcript .me-card .attachments')].find((n) => n.textContent.includes('diagram.svg'))`;
  await page.waitFor(`${sent}?.querySelector('img')?.complete`, { label: 'the thumbnail to load' }).catch(() => {});
  const thumb = await page.evaluate(`(() => {
    const box = ${sent};
    const img = box?.querySelector('img');
    const link = img?.closest('a');
    if (!img || !link) return null;
    const r = img.getBoundingClientRect();
    return { src: img.getAttribute('src'), alt: img.alt, natural: img.naturalWidth, w: r.width, h: r.height, href: link.getAttribute('href'), target: link.target, rel: link.rel, name: link.textContent };
  })()`);
  check('a PNG attachment shows a thumbnail', !!thumb, 'no <img> in the sent message');
  if (thumb) {
    check('the thumbnail is served by /api/files and loads', /^\/api\/files\/fi/.test(thumb.src) && thumb.natural === 64, JSON.stringify(thumb));
    check('the thumbnail’s alt text is the file name', thumb.alt === 'shot.png', thumb.alt);
    check('the thumbnail has a fixed size', thumb.w === 160 && thumb.h === 120, `${thumb.w}×${thumb.h}`);
    check('the thumbnail is a link to the full image in a new tab', thumb.href === thumb.src && thumb.target === '_blank' && /noopener/.test(thumb.rel));
    check('the link shows the name and size', /shot\.png · \d+ KB/.test(thumb.name), thumb.name);
    const res = await fetch(origin + thumb.href);
    check(
      'the full image is served inline as a PNG',
      res.headers.get('content-type') === 'image/png' && /^inline/.test(res.headers.get('content-disposition') ?? ''),
    );
    // Keyboard: focus the link and press Enter; the full image opens in a new tab.
    await page.send('Target.setDiscoverTargets', { discover: true });
    const opened = new Promise((ok) => {
      page.on('Target.targetCreated', (p) => p.targetInfo.type === 'page' && ok(p.targetInfo));
      setTimeout(() => ok(null), 5000).unref();
    });
    const focused = await page.evaluate(
      `(() => { const a = ${sent}.querySelector('a.att-image'); a.scrollIntoView({ block: 'center' }); a.focus(); return document.activeElement === a; })()`,
    );
    check('the thumbnail link takes keyboard focus', focused);
    for (const type of ['keyDown', 'keyUp'])
      await page.send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        ...(type === 'keyDown' ? { text: '\r' } : {}),
      });
    const tab = await opened;
    await sleep(500);
    const url = tab ? ((await page.send('Target.getTargets')).targetInfos.find((t) => t.targetId === tab.targetId)?.url ?? tab.url) : '';
    check('Enter on the thumbnail opens the full image', url.endsWith(thumb.href), url || 'no new tab');
    if (tab) await page.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
  }
  const svg = await page.evaluate(`(() => {
    const chip = [...${sent}.querySelectorAll('.att')].find((n) => n.textContent.includes('diagram.svg'));
    return chip ? { img: !!chip.querySelector('img'), link: chip.querySelector('a')?.getAttribute('href') ?? '' } : null;
  })()`);
  check('an SVG attachment keeps the file chip', !!svg && !svg.img && /^\/api\/files\//.test(svg.link), JSON.stringify(svg));

  // 2 · Drops on a topic thread’s panel attach there; drops on the conversation still attach to it.
  await page.goto(`${origin}/?v=2#/t/${conv.id}/side/${topicId}`); // a new query, so the page loads again
  await page.waitFor(`!!document.getElementById('side-input')`, { label: 'the topic thread’s composer' });
  await page.evaluate(DROP);
  const onPanel = await page.evaluate(`window.__drop('aside.sidepanel .sp-body', 'png', 'panel.png')`);
  check('a drop on the panel is allowed and taken', onPanel.allowed && onPanel.taken, JSON.stringify(onPanel));
  await page.waitFor(`${chips('aside.sidepanel')}.some((t) => t.includes('panel.png'))`, { label: 'the panel’s attachment', timeout: 3000 }).catch(() => {});
  check(
    'a file dropped on the panel attaches to the panel’s composer',
    (await page.evaluate(`${chips('aside.sidepanel')}`)).some((t) => t.includes('panel.png')),
  );
  check('a file dropped on the panel doesn’t attach to the conversation’s composer', (await page.evaluate(`${chips('.main')}.length`)) === 0);
  await page.evaluate(`window.__drop('.main .transcript', 'png', 'main.png')`);
  await page.waitFor(`${chips('.main')}.some((t) => t.includes('main.png'))`, { label: 'the conversation’s attachment', timeout: 3000 }).catch(() => {});
  check(
    'with the panel open, a drop on the conversation attaches to its composer',
    (await page.evaluate(`${chips('.main')}`)).some((t) => t.includes('main.png')),
  );
  check('…and not to the panel’s', (await page.evaluate(`${chips('aside.sidepanel')}.length`)) === 1);
  const hint = await page.evaluate(`(() => {
    document.querySelector('aside.sidepanel [aria-label="Add a file or a new agent"]').click();
    const d = [...document.querySelectorAll('.menu .mi')].find((n) => n.textContent.includes('Upload from computer'))?.textContent ?? '';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return d;
  })()`);
  check('the panel’s plus menu says where to drop files', hint.includes('Or drop files on this thread'), hint);
  const errors = page.logs.filter((l) => !/favicon/.test(l));
  check('no errors in the page', errors.length === 0, errors.join('; '));
} catch (e) {
  check('the check ran to the end', false, e.message);
} finally {
  await page?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
