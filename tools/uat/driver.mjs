// Drives Postbox in headless Chrome the way a person does: real clicks and key presses, typing, and the file
// picker. It reads what’s on screen from the page, never from the API, so the UAT sees what a person sees.
// Agent apps run in sandboxed frames; the driver reaches into them through an isolated world (CDP), to read
// and click them as a person would.

import { writeFile } from 'node:fs/promises';
import { sleep } from '../cdp.mjs';
import { review } from './driver-review.mjs';
import { ITEM, J } from './selectors.mjs';

// The answers to Stop’s question about background jobs, in the decision’s words (#126), with “Stop them too” for more
// than one job. Written against fix/p0-stop’s ask row before it merged; if its buttons change, change them here.
export const JOBS_ANSWERS = { stop: ['Stop it too', 'Stop them too'], keep: ['Keep running'] };
/** The visible answer button of Postbox’s ask: in its row above the composer, or outside any agent block or app. */
const JOBS_BUTTON = (answer) =>
  `[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && (b.closest('.stop-ask') || !b.closest('[data-key]')) && ${J(JOBS_ANSWERS[answer] ?? [])}.includes(b.textContent.replace(/\\s+/g, ' ').trim()))`;
/** The text of the ask a button belongs to. */
const JOBS_BOX = (b) =>
  `((${b}.closest('.stop-ask, [role=dialog], [role=alertdialog], .dialog, .toast') ?? ${b}.parentElement)?.innerText ?? ${b}.textContent).replace(/\\s+/g, ' ').trim().slice(0, 400)`;

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

    /** Replies in the thread panel that’s open, to whoever is in that thread: messages inside the panel have no “Reply in thread”. */
    async replyInOpenThread(text) {
      if (!(await ev(`!!document.getElementById('side-input')`))) throw new Error('No thread is open in the right pane: open one with thread first.');
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
      // A control may be a link, such as a reply’s work line (“2 files +112 −0”), which opens the Work pane.
      if (button) await clickAt(byText(ITEM(key), 'button, a[href], [role=button]', button), `the button “${button}”`);
    },

    review(key, opts) {
      return review({ ev, clickAt, byText, typeInto }, key, opts);
    },

    /**
     * Opens Settings › Personas › Edit @handle, as a person does, and reads what the editor says; with
     * `permissions`, also its Permissions… panel. Screenshots go to `shots`, named by `stem`. Closes it all after.
     * @param {string} handle  @param {{ permissions?: boolean, shots: string, stem: string }} opts
     * @returns {Promise<{ editor: string, panel: string|null, files: string[] }>}
     */
    async personaSettings(handle, { permissions = false, shots, stem }) {
      const h = String(handle).replace(/^@/, '');
      const top = `[...document.querySelectorAll('.dialog')].at(-1)`;
      // The text, then what its fields hold, which innerText leaves out: the model typed in, the backend picked.
      const read = () =>
        ev(`(() => {
          const d = ${top};
          if (!d) return '';
          const name = (c) => (c.id && d.querySelector('label[for="' + c.id + '"]')?.textContent) || c.closest('label')?.textContent || c.getAttribute('aria-label') || '';
          const values = [...d.querySelectorAll('input, select, textarea')]
            .filter((c) => c.offsetParent !== null && c.type !== 'file')
            .map((c) => name(c).trim().replace(/\\s+/g, ' ').slice(0, 60) + ': ' + (c.type === 'checkbox' ? (c.checked ? 'on' : 'off') : c.tagName === 'SELECT' ? c.selectedOptions[0]?.textContent ?? '' : c.value || '(empty)').slice(0, 120))
            .filter((v) => !v.startsWith(': '));
          for (const c of d.querySelectorAll('[role=checkbox]'))
            values.push((c.getAttribute('aria-label') || c.textContent).trim().replace(/\\s+/g, ' ').slice(0, 60) + ': ' + (c.getAttribute('aria-checked') === 'true' ? 'on' : 'off'));
          return d.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, 2500) + (values.length ? '\\n\\nFields hold: ' + values.join('; ') : '');
        })()`);
      const files = [];
      const shoot = async (name) => {
        const f = `${shots}/${stem}-${name}.png`;
        const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
        await writeFile(f, Buffer.from(data, 'base64'));
        files.push(f);
      };
      try {
        await clickAt(`document.querySelector('[aria-label="Settings"]')`, 'the Settings button');
        await clickAt(byText('document.querySelector(".dialog")', '[role=tab], button', 'Personas'), 'the Personas tab');
        await clickAt(`document.querySelector(${J(`.dialog [aria-label="Edit @${h}"]`)})`, `Edit @${h}`);
        await page.waitFor(`!!document.getElementById('pe-d')`, { label: 'the persona editor' });
        await sleep(300);
        const editor = await read();
        await shoot('persona');
        let panel = null;
        if (permissions) {
          if (!(await ev(`!!document.getElementById('pe-perms')`))) panel = '(This persona has no Permissions… button: it runs on the mock.)';
          else {
            const before = await ev(`document.querySelectorAll('.dialog').length`);
            await clickAt(`document.getElementById('pe-perms')`, 'Permissions…');
            await page.waitFor(`document.querySelectorAll('.dialog').length > ${before}`, { label: 'the permissions panel' });
            await sleep(800);
            panel = await read();
            await shoot('permissions');
          }
        }
        return { editor, panel, files };
      } finally {
        for (let i = 0; i < 3 && (await ev(`!!document.querySelector('.backdrop')`)); i++) await press('Escape');
      }
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
    /**
     * Opens an agent’s quick panel from the sidebar’s Agents section (#105), sets what’s given, and closes it.
     * Returns what the panel said, and what each control was left at.
     * @param {string} handle  @param {{ model?: string, effort?: string, mode?: string, shell?: boolean }} set
     */
    async agentPanel(handle, set = {}) {
      await clickAt(
        `document.querySelector(${J(`.agent-row [aria-label="More for @${handle}"]:not([hidden])`)}) ?? [...document.querySelectorAll('.agent-btn')].find((b) => b.offsetParent !== null && b.textContent.includes(${J(`@${handle}`)}))`,
        `@${handle}’s row in the Agents section`,
      );
      await page.waitFor(`!!document.querySelector('.dialog [role=radiogroup], .dialog [role=switch]')`, { label: 'the quick panel' });
      try {
        const group = (label) =>
          `[...document.querySelectorAll('.dialog [role=radiogroup]')].find((g) => (g.getAttribute('aria-label') ?? '').toLowerCase().startsWith(${J(label.toLowerCase())}))`;
        for (const [label, value] of [
          ['Model', set.model],
          ['Effort', set.effort],
          ['Permission mode', set.mode],
        ]) {
          if (!value) continue;
          await clickAt(
            `[...(${group(label)}?.querySelectorAll('[role=radio]') ?? [])].find((r) => r.textContent.toLowerCase().includes(${J(String(value).toLowerCase())}))`,
            `“${value}” under ${label}`,
          );
        }
        const shellSwitch = `[...document.querySelectorAll('.dialog [role=switch]')].find((x) => (x.getAttribute('aria-label') ?? '').startsWith('Shell,'))`;
        if (set.shell !== undefined && (await ev(`${shellSwitch}?.getAttribute('aria-checked') === 'true'`)) !== Boolean(set.shell))
          await clickAt(shellSwitch, 'the Shell switch');
        await sleep(400);
        const said = await ev(`document.querySelector('.dialog')?.innerText ?? ''`);
        const left = await ev(`({
          groups: Object.fromEntries([...document.querySelectorAll('.dialog [role=radiogroup]')].map((g) => [g.getAttribute('aria-label'), g.querySelector('[aria-checked=true]')?.textContent.trim() ?? null])),
          switches: Object.fromEntries([...document.querySelectorAll('.dialog [role=switch]')].map((x) => [x.getAttribute('aria-label'), x.getAttribute('aria-checked') === 'true'])),
        })`);
        return { said, left };
      } finally {
        // Closed whatever happened, so the next action starts from the conversation.
        if (await ev(`!!document.querySelector('.dialog')`)) await press('Escape');
      }
    },

    /** Opens a view in the right pane: Work by its top-bar button, or the thread on an item (#146). Returns both views’ sizes. */
    async openPane(view, key = null) {
      if (view === 'work') {
        if (!(await ev(`document.getElementById('work-button')?.getAttribute('aria-pressed') === 'true'`)))
          await clickAt(`document.getElementById('work-button')`, 'the Work button');
      } else if (key) await clickAt(byText(ITEM(key), 'a, button', 'thread'), 'the item’s thread link');
      await sleep(600);
      return ev(`(() => {
        const size = (sel) => { const n = document.querySelector(sel); const b = n?.getBoundingClientRect(); return b && b.height ? { w: Math.round(b.width), h: Math.round(b.height) } : null; };
        return { work: size('.rpane > .workpane'), thread: size('.rpane > .sidepanel'), viewport: { w: innerWidth, h: innerHeight } };
      })()`);
    },

    /**
     * Opens the thread full screen, types a draft without sending it, and leaves full screen, the way the person
     * would (#146): reports whether the draft and the scroll survived.
     */
    async fullscreenDraft(text) {
      const box = `document.querySelector('.rpane .sidepanel textarea')`;
      // Where the thread is scrolled, and how far from its end: a thread kept at its end may move as it re-wraps.
      const scroll = `(() => { const b = document.querySelector('.rpane .sidepanel .sp-body'); return b ? { top: Math.round(b.scrollTop), gap: Math.round(b.scrollHeight - b.clientHeight - b.scrollTop) } : { top: 0, gap: 0 }; })()`;
      const before = await ev(scroll);
      await clickAt(`document.getElementById('thread-full')`, 'the thread’s full-screen button');
      await sleep(400);
      const full = await ev(`!!document.querySelector('.pane-full')`);
      await typeInto(box, text, 'the thread’s composer');
      await press('Escape');
      await sleep(400);
      const out = await ev(
        `({ draft: ${box}?.value ?? null, exited: !document.querySelector('.pane-full'), focus: document.activeElement?.id ?? document.activeElement?.tagName })`,
      );
      return { full, before, after: await ev(scroll), kept: out.draft === text, ...out };
    },

    /** Opens a view full screen (#146), and returns what it shows, then leaves it with Escape. */
    async fullscreen(view) {
      if (view === 'thread') await clickAt(`document.getElementById('thread-full')`, 'the thread’s full-screen button');
      else await clickAt(byText(`document.querySelector('.rpane .workpane')`, 'button', 'Full screen'), 'Work’s full-screen button');
      await sleep(600);
      const shown = await ev(`document.querySelector('.pane-full')?.innerText.slice(0, 4000) ?? ''`);
      await press('Escape');
      return shown;
    },

    /** In Work full screen, restores (or removes) a file the agents changed, and confirms (#138). Returns the toast or error text. */
    async restoreFile(file) {
      await this.openPane('work');
      await clickAt(byText(`document.querySelector('.rpane .workpane')`, 'button', 'Full screen'), 'Work’s full-screen button');
      await sleep(600);
      await clickAt(
        `[...document.querySelectorAll('.pane-full button[id^=restore-]')].find((b) => (b.closest('li, tr, section, div')?.textContent ?? '').includes(${J(file)}))`,
        `Restore… for ${file}`,
      );
      await clickAt(`document.querySelector('.dialog .btn.danger')`, 'the confirm button');
      await sleep(800);
      const said = await ev(`[...document.querySelectorAll('.toast, .dialog .err')].map((x) => x.innerText).join(' | ')`);
      await press('Escape');
      return said;
    },

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
      await ev(
        `(() => { const b = [...document.querySelectorAll('.composer button.stop')].find((x) => x.getClientRects().length && !x.disabled); if (!b) throw new Error('No Stop control is visible.'); b.click(); })()`,
      );
    },

    /**
     * Postbox’s question about an agent’s background jobs, if it’s on screen: since #126, Stop asks whether to stop
     * them too. Read by its buttons, in Postbox’s own frame: a row above the composer (.stop-ask), or anywhere but an
     * agent’s block or app, whose own buttons could say the same words.
     * @returns {Promise<string|null>}
     */
    jobsAsk: () => ev(`(() => { const b = ${JOBS_BUTTON('stop')} ?? ${JOBS_BUTTON('keep')}; return b ? ${JOBS_BOX('b')} : null; })()`),

    /** Answers that question: stop the jobs too, or keep them running. @param {'stop'|'keep'} answer */
    async answerJobs(answer) {
      if (!JOBS_ANSWERS[answer]) throw new Error(`Answer background jobs with stop or keep, not “${answer}”.`);
      await clickAt(JOBS_BUTTON(answer), `“${JOBS_ANSWERS[answer][0]}”`);
    },

    /**
     * Postbox’s notices on blocks whose answer it refused because the agent changed them while the person was answering
     * (#123), by item: the page’s own record of the refusal, which the server keeps nowhere.
     * @returns {Promise<{ key: string|null, text: string }[]>}
     */
    staleNotes: () =>
      ev(
        `[...document.querySelectorAll('.stale-note')].map((n) => ({ key: n.closest('[data-key]')?.dataset.key ?? null, text: n.textContent.replace(/\\s+/g, ' ').trim().slice(0, 300) }))`,
      ),

    /** Whether an item is in the thread panel, where its agent’s composer is the panel’s. @param {string} key */
    inPanel: (key) => ev(`!!${ITEM(key)}?.closest('.sidepanel')`),

    /**
     * Acts while an agent’s turn runs, as a person does mid-turn: waits until the composer shows Stop (an agent is
     * working there), lets it work `after` seconds, then presses Stop, or writes `text` and presses Send now on it
     * once it’s queued, or answers a block with `answer` (the runner’s, which answers as act or review do: a draft
     * answered while its agent revises it, #123). After Stop, it answers Postbox’s question about background jobs with
     * `jobs`, if it asks. `panel` picks the thread panel’s composer over the conversation’s; `onWait` runs every few
     * seconds meanwhile.
     * @param {{ after?: number, do: 'stop'|'send_now'|'answer', jobs?: 'stop'|'keep'|null, text?: string }} what
     * @param {{ panel?: boolean, onWait?: () => Promise<void>, answer?: () => Promise<string> }} [opts]
     * @returns {Promise<string>}  what happened, for the tester
     */
    async interrupt({ after = 20, do: action, jobs = null, text = '' }, { panel = false, onWait = async () => {}, answer = null } = {}) {
      if (action !== 'stop' && action !== 'send_now' && action !== 'answer') throw new Error(`An interrupt is stop, send_now or answer, not “${action}”.`);
      if (action === 'answer' && !answer) throw new Error('An answer while the agent works needs the block to answer.');
      if (action === 'send_now' && !String(text).trim()) throw new Error('Send now needs the message to send.');
      const composer = panel
        ? `document.querySelector('.sidepanel .composer')`
        : `[...document.querySelectorAll('.composer')].find((c) => !c.closest('.sidepanel'))`;
      const stop = `${composer}?.querySelector('button.stop')`;
      const working = () => ev(`(() => { const b = ${stop}; return !!b && b.offsetParent !== null; })()`);
      for (let i = 0; i < 360 && !(await working()); i++) await sleep(250);
      if (!(await working())) return 'No agent started working here within 90 s, so nothing was interrupted.';
      const end = Date.now() + Math.max(0, Math.min(600, Number(after) || 0)) * 1000;
      let waited = Date.now();
      while (Date.now() < end) {
        if (!(await working())) return `The agent finished before ${after} s had passed, so nothing was interrupted.`;
        if (Date.now() - waited > 5000) {
          await onWait();
          waited = Date.now();
        }
        await sleep(500);
      }
      const who = String((await ev(`${stop}?.getAttribute('aria-label') ?? ''`)) ?? '').replace(/^Stop /, '');
      const notes = [];
      // An answer isn’t a Stop: Postbox asks nothing about background jobs.
      if (action === 'answer') return `${await /** @type {() => Promise<string>} */ (answer)()} (after ${after} s of ${who || 'its reply'})`;
      if (action === 'stop') {
        await clickAt(stop, 'the Stop button');
        notes.push(`Pressed Stop on ${who || 'the working agent’s reply'} after ${after} s.`);
      } else {
        const input = panel ? `document.getElementById('side-input')` : `document.getElementById('composer-input')`;
        await typeInto(input, String(text), 'the composer');
        await press('Enter');
        const row = `[...(${composer}?.querySelectorAll('.queued:not(.stop-ask)') ?? [])].find((r) => r.textContent.includes(${J(String(text).trim().slice(0, 60))}))`;
        for (let i = 0; i < 20 && !(await ev(`!!${row}`)); i++) await sleep(150);
        if (await ev(`!!${row}`)) {
          await clickAt(byText(row, 'button', 'Send now'), 'Send now on the queued message');
          notes.push(`Wrote the message while ${who || 'an agent’s reply'} was running, and pressed Send now on it after ${after} s.`);
        } else notes.push('The message wasn’t queued: the agent had finished, so it went at once.');
      }
      // The question about background jobs, if Postbox asks one.
      let ask = null;
      for (let i = 0; i < 20 && !(ask = await this.jobsAsk()); i++) await sleep(250);
      if (!ask) notes.push('Postbox didn’t ask about background jobs.');
      else if (jobs) {
        await this.answerJobs(jobs);
        notes.push(`Postbox asked: “${ask}” You answered “${JOBS_ANSWERS[jobs][0]}”.`);
      } else notes.push(`Postbox asks: “${ask}” Answer it with jobs.`);
      return notes.join(' ');
    },
  };
}
