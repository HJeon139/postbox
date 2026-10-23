// Drives Postbox in headless Chrome the way a person does: real clicks and key presses, typing, and the file
// picker. It reads what’s on screen from the page, never from the API, so the UAT sees what a person sees.
// Agent apps run in sandboxed frames; the driver reaches into them through an isolated world (CDP), to read
// and click them as a person would.

import { writeFile } from 'node:fs/promises';
import { sleep } from '../cdp.mjs';

const J = JSON.stringify;
const ITEM = (key) => `document.querySelector('[data-key=${J(key)}]')`;

/** @param {any} page  from tools/cdp.mjs launch() */
export function driver(page) {
  const ev = (expr) => page.evaluate(expr);

  /** Clicks the centre of the first element that matches, after scrolling it into view. */
  async function clickAt(findExpr, what) {
    const r = await ev(`(() => {
      const el = ${findExpr};
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`);
    if (!r) throw new Error(`Couldn’t find ${what} on screen.`);
    await sleep(120);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(250);
  }
  // Matches a control by its visible text or its label, since icon buttons (Expand table) have only a label.
  const byText = (scope, sel, text) =>
    `[...(${scope}?.querySelectorAll(${J(sel)}) ?? [])].find((e) => e.offsetParent !== null && (e.textContent + ' ' + (e.getAttribute('aria-label') ?? '')).replace(/\\s+/g, ' ').trim().toLowerCase().includes(${J(String(text).toLowerCase())}))`;
  const press = async (key) => {
    const codes = { Enter: 13, Escape: 27, Tab: 9 };
    for (const type of ['keyDown', 'keyUp'])
      await page.send('Input.dispatchKeyEvent', {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: codes[key],
        ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : {}),
      });
    await sleep(150);
  };
  const typeInto = async (findExpr, text, what) => {
    await clickAt(findExpr, what);
    await ev(`(() => { const el = ${findExpr}; if (el && 'value' in el) { el.select?.(); } })()`);
    await page.send('Input.insertText', { text });
    await sleep(150);
  };

  /** The isolated-world context of an agent app’s frame, so its content can be read and clicked. */
  async function appContext(key) {
    // Apps far off screen are unloaded: bring it into view, and give its frame a moment to load.
    await ev(`${ITEM(key)}?.scrollIntoView({ block: 'center' })`);
    for (let i = 0; i < 20 && !(await ev(`!!${ITEM(key)}?.querySelector('.appframe iframe')`)); i++) await sleep(200);
    await sleep(800);
    const { result } = await page.send('Runtime.evaluate', { expression: `${ITEM(key)}?.querySelector('.appframe iframe, iframe')` });
    if (!result.objectId) return null;
    const { node } = await page.send('DOM.describeNode', { objectId: result.objectId });
    if (!node.frameId) return null;
    const frameRect = await ev(
      `(() => { const b = ${ITEM(key)}.querySelector('.appframe iframe, iframe').getBoundingClientRect(); return { x: b.left, y: b.top }; })()`,
    );
    // Chrome runs sandboxed frames in their own process; cdp.mjs attaches to each one.
    const session = page.frameSession(node.frameId);
    if (session) return { session, frameRect };
    try {
      const { executionContextId } = await page.send('Page.createIsolatedWorld', { frameId: node.frameId, worldName: 'uat' });
      return { id: executionContextId, frameRect };
    } catch {
      return null;
    }
  }
  const inApp = async (ctx, expression) => {
    const r = ctx.session
      ? await page.send('Runtime.evaluate', { expression, returnByValue: true }, ctx.session)
      : await page.send('Runtime.evaluate', { expression, contextId: ctx.id, returnByValue: true });
    return r.result?.value;
  };

  return {
    clickAt,
    press,

    async newProject(name, folder) {
      await clickAt(`document.querySelector('[aria-label="Settings"]')`, 'the Settings button');
      await clickAt(byText('document.querySelector(".dialog")', '[role=tab], button', 'Projects'), 'the Projects tab');
      await typeInto(`document.getElementById('pj-n')`, name, 'the project name field');
      await typeInto(`document.getElementById('pj-f')`, folder, 'the project folder field');
      await clickAt(byText('document.querySelector(".dialog")', 'button', 'Create project'), 'Create project');
      await sleep(400);
      await press('Escape');
    },

    /** Opens a project from the Postbox menu, then starts a conversation (or room) with these agents. */
    async newConversation(project, title, handles) {
      await clickAt(`document.querySelector('button.brand')`, 'the Postbox menu');
      await clickAt(byText('document', '.menu .mi, [role=menuitem]', project), `“${project}” in the Postbox menu`);
      await sleep(500);
      const room = handles.length > 1;
      await clickAt(`document.querySelector('[aria-label=${J(room ? 'New room' : 'New conversation')}]')`, 'the new conversation button');
      await typeInto(`document.getElementById('nt-title')`, title, 'the conversation title');
      // The sheet preselects one agent for a direct message, so set each chip to what's wanted rather than toggling it.
      const chips = await ev(
        `[...document.querySelectorAll('.dialog button.chip')].map((b) => [b.textContent.trim(), b.getAttribute('aria-pressed') === 'true'])`,
      );
      for (const [label, on] of chips) {
        const want = handles.some((handle) => label.split(/\s+/).includes(`@${handle}`));
        if (want !== on) await clickAt(byText('document.querySelector(".dialog")', 'button.chip', label), `${label} in the sheet`);
      }
      await clickAt(byText('document.querySelector(".dialog")', 'button.send', 'Start'), 'the Start button');
      await page.waitFor(`!!document.getElementById('composer-input')`, { label: 'the composer' });
      return ev('location.hash');
    },

    async send(text) {
      await typeInto(`document.getElementById('composer-input')`, text, 'the composer');
      await press('Enter');
    },

    /** “Reply in thread” under a message, then a message in the thread panel. */
    async replyInThread(key, text) {
      // “Reply in thread”, or “N replies” once the thread exists: either opens it in the panel.
      await clickAt(
        `(${ITEM(key)}?.querySelector('.msg-actions a.replies') ?? ${byText(ITEM(key), '.msg-actions button', 'Reply in thread')})`,
        'Reply in thread under that message',
      );
      await page.waitFor(`!!document.getElementById('side-input')`, { label: 'the thread panel' });
      await typeInto(`document.getElementById('side-input')`, text, 'the thread reply box');
      await press('Enter');
    },

    /** Fills fields, picks options and presses a button inside one item (a block or a card). */
    async act(key, { fills = [], choose = [], button = null } = {}) {
      for (const { field, value } of fills) {
        const control = `(() => {
          const item = ${ITEM(key)};
          const label = [...item.querySelectorAll('label')].find((l) => l.textContent.toLowerCase().includes(${J(String(field).toLowerCase())}));
          return label?.htmlFor ? document.getElementById(label.htmlFor) : label?.querySelector('input, textarea, select');
        })()`;
        const tag = await ev(`${control}?.tagName ?? null`);
        if (!tag) throw new Error(`Couldn’t find the field “${field}”.`);
        if (tag === 'SELECT')
          await ev(
            `(() => { const s = ${control}; const o = [...s.options].find((o) => o.textContent.toLowerCase().includes(${J(String(value).toLowerCase())})); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); } })()`,
          );
        else await typeInto(control, String(value), `the field “${field}”`);
      }
      for (const option of choose) await clickAt(byText(ITEM(key), 'button.chip, [role=radio], [role=checkbox], label', option), `the option “${option}”`);
      if (button) await clickAt(byText(ITEM(key), 'button', button), `the button “${button}”`);
    },

    /**
     * Answers a review block as a person does: a draft comment on each line (its gutter button, the box, “Add draft
     * comment”), then the verdict, then Submit review. Request changes and Comment need a comment to say what.
     * @param {string} key  @param {{ verdict?: string, comments?: { line: string, text: string }[] }} review
     */
    async review(key, { verdict = 'comment', comments = [] } = {}) {
      const names = { approve: 'Approve', request_changes: 'Request changes', comment: 'Comment' };
      if (!names[verdict]) throw new Error(`A review’s verdict is approve, request_changes or comment, not “${verdict}”.`);
      if (verdict !== 'approve' && !comments.length) throw new Error('Request changes and Comment need at least one comment on a line, saying what to change.');
      if (!(await ev(`!!${ITEM(key)}?.querySelector('[aria-label="Verdict"]')`))) throw new Error('That item isn’t a review waiting for an answer.');
      for (const { line, text } of comments) {
        const n = String(line)
          .replace(/^line\s*/i, '')
          .trim();
        await clickAt(`${ITEM(key)}?.querySelector(${J(`button[aria-label="Comment on line ${n}"]`)})`, `line ${n}’s comment button`);
        const box = `${ITEM(key)}?.querySelector(${J(`textarea[aria-label="Comment on line ${n}"]`)})`;
        await typeInto(box, String(text), `the comment box on line ${n}`);
        await clickAt(byText(ITEM(key), 'button', 'Add draft comment'), '“Add draft comment”');
      }
      await clickAt(byText(`${ITEM(key)}?.querySelector('[aria-label="Verdict"]')`, '[role=radio]', names[verdict]), `the verdict “${names[verdict]}”`);
      await clickAt(byText(ITEM(key), 'button', 'Submit review'), '“Submit review”');
    },

    /** Attaches a file through the composer’s file picker. */
    async attach(file) {
      const { result } = await page.send('Runtime.evaluate', { expression: `document.querySelector('.composer input[type=file]')` });
      if (!result.objectId) throw new Error('Couldn’t find the composer’s file picker.');
      await page.send('DOM.setFileInputFiles', { files: [file], objectId: result.objectId });
      await sleep(800);
    },

    /** Clicks something inside an agent app by its visible text, with a real mouse event. */
    async appClick(key, text) {
      const ctx = await appContext(key);
      if (!ctx) throw new Error('Couldn’t reach inside that app.');
      await ev(`${ITEM(key)}.scrollIntoView({ block: 'center' })`);
      await sleep(200);
      const fresh = await appContext(key);
      const r = await inApp(
        fresh,
        `(() => { const el = [...document.querySelectorAll('button, a, [role=button], [role=tab], label, summary, option, li, td, text, g')].find((e) => e.textContent.trim().toLowerCase().includes(${J(String(text).toLowerCase())})); if (!el) return null; if (el.tagName === 'OPTION') { const s = el.closest('select'); s.value = el.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return { selected: true }; } const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
      );
      if (!r) throw new Error(`Couldn’t find “${text}” in the app.`);
      // A native dropdown’s options can’t be clicked where they’re drawn, so the option is chosen the way a person’s pick ends.
      if (r.selected) return sleep(400);
      const x = fresh.frameRect.x + r.x;
      const y = fresh.frameRect.y + r.y;
      // Rest the pointer on it first, as a hand does: an app frame takes clicks once Postbox sees you point at it (#38).
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(100);
      for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      await sleep(400);
    },

    /** What’s inside an app: its text, and the size of its SVG marks and text (for the legibility check). */
    async appInside(key) {
      const ctx = await appContext(key);
      if (!ctx) return null;
      return inApp(
        ctx,
        `(() => {
          const marks = [...document.querySelectorAll('svg circle, svg rect, svg path, svg line, svg ellipse')].map((m) => { const b = m.getBoundingClientRect(); return Math.max(b.width, b.height); }).filter((s) => s > 0);
          const texts = [...document.querySelectorAll('svg text')].map((t) => parseFloat(getComputedStyle(t).fontSize) * (t.getScreenCTM?.()?.a ?? 1));
          const fonts = [...new Set([...document.querySelectorAll('body, body *')].slice(0, 400).map((e) => getComputedStyle(e).fontFamily))];
          return { text: document.body.innerText.slice(0, 2000), marks: marks.length, tinyMarks: marks.filter((s) => s < 4).length, svgText: texts.length, tinyText: texts.filter((s) => s < 9).length, fonts: fonts.slice(0, 6) };
        })()`,
      );
    },

    /** Everything visible in the conversation (and the thread panel, if open), by item. */
    async items() {
      // Read what a person sees: KaTeX keeps a visually hidden MathML copy (with the TeX source) for screen
      // readers, which innerText would read as a second, garbled formula.
      await ev(
        `document.getElementById('uat-reading') ?? document.head.append(Object.assign(document.createElement('style'), { id: 'uat-reading', textContent: '.katex-mathml, .sr-only, [hidden] { display: none !important; }' }))`,
      );
      return ev(`(() => {
        const read = (root, where) => [...root.querySelectorAll(':scope > .item')].map((n) => ({
          key: n.dataset.key,
          where,
          text: n.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, 3000),
          block: n.querySelector('.block-head .kind')?.textContent ?? null,
          app: !!n.querySelector('.appframe'),
          diagram: !!n.querySelector('figure.diagram'),
          math: !!n.querySelector('.katex'),
          images: n.querySelectorAll('.me-card img, .attachments img').length,
          attachments: n.querySelectorAll('.attachments .att').length,
          buttons: [...n.querySelectorAll('button')].filter((b) => b.offsetParent !== null && !b.closest('.msg-actions')).map((b) => (b.textContent.trim() || b.getAttribute('aria-label') || '').slice(0, 60)).filter(Boolean),
          fields: [...n.querySelectorAll('label')].map((l) => l.textContent.trim().slice(0, 60)).filter(Boolean),
        }));
        const main = document.querySelector('#main.transcript');
        const side = document.querySelector('.sidepanel .transcript');
        return [...(main ? read(main, 'conversation') : []), ...(side ? read(side, 'thread panel') : [])];
      })()`);
    },

    /** The working row: which agents it shows, and their glimpse. */
    working: () => ev(`[...document.querySelectorAll('.working .work-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())`),

    /**
     * What a person sees of an item: scrolled to just below the top bar, and only what fits in the window.
     * (Capturing beyond the window paints the sticky top bar mid-item, and leaves sandboxed frames blank.)
     */
    async shotItem(key, file) {
      const ok = await ev(
        `(() => { const n = ${ITEM(key)}; if (!n) return false; n.scrollIntoView({ block: 'start' }); scrollBy(0, -((document.querySelector('header.topbar')?.offsetHeight ?? 0) + 8)); return true; })()`,
      );
      if (!ok) return null;
      // Apps far off screen are unloaded; give them a moment to load again and draw. (The clip is in page
      // coordinates, so the scroll offset is added below.)
      await sleep((await ev(`!!${ITEM(key)}.querySelector('iframe')`)) ? 2500 : 300);
      const r = await ev(
        `(() => { const b = ${ITEM(key)}.getBoundingClientRect(); const top = Math.max(b.top - 6, 0); return { x: Math.max(0, b.left - 6) + scrollX, y: top + scrollY, width: Math.min(b.width + 12, innerWidth), height: Math.max(1, Math.min(b.bottom + 6, innerHeight) - top) }; })()`,
      );
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
      await writeFile(file, Buffer.from(data, 'base64'));
      return file;
    },

    async shotScreen(file) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(file, Buffer.from(data, 'base64'));
      return file;
    },

    /** Presses an app’s Expand (full screen) button and reports whether anything visibly changed. */
    async probeFullScreen(key) {
      const before = await ev(
        `(() => { const f = ${ITEM(key)}?.querySelector('.appframe'); const b = f?.getBoundingClientRect(); return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null; })()`,
      );
      if (!before) return null;
      await clickAt(`${ITEM(key)}.querySelector('.appframe [aria-label="Expand"], .appframe [aria-label="Full screen"]')`, 'the app’s Expand button');
      await sleep(500);
      const after = await ev(
        `(() => { const f = document.querySelector('.fullscreen .appframe') ?? ${ITEM(key)}?.querySelector('.appframe'); const b = f?.getBoundingClientRect(); return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null; })()`,
      );
      // Put it back the way it was.
      await ev(`${ITEM(key)}?.querySelector('.appframe [aria-label="Collapse"]')?.click()`);
      await press('Escape');
      return { before, after, viewport: await ev('({ w: innerWidth, h: innerHeight })') };
    },

    async stopAll() {
      await ev(`document.querySelector('.composer button.stop')?.click()`);
    },
  };
}
