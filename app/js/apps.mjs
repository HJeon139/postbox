// Agent-written apps on the host side: sandboxed frames, the bridge, the pre-display check, versions,
// review mode, Expand, and unloading far-off-screen frames (they reload from saved state as you approach).
// Also renders Mermaid diagrams (in their own sandbox) and KaTeX math in messages.

import { MIN_TEXT_PX } from '/shared/diagram-lint.mjs';
import { api, client } from './client.mjs';
import { $$, ago, h, icon, plural } from './dom.mjs';
import { openMenu, toast } from './ui.mjs';

const frames = new Set(); // { appId, version, iframe, check, review, onPin, onAnchors, onCrash }
const checks = new Map(); // `${appId}:${v}` → { results: Map(width → problems), frames }
const crashes = new Map(); // `${appId}:${v}` → message (a script error after the app was shown)
const reloaded = new Set(); // `${appId}:${v}` you chose Reload for after its check crashed: run it, don’t show the crash again
const viewing = new Map(); // appId → an older version you’re looking at, read-only
const expanded = new Set();
const unloaded = new Set(); // appIds whose frames are unloaded while off screen
const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const cap = () => Math.min(innerHeight * 0.8, 760);

addEventListener('message', async (e) => {
  let rec = null;
  for (const r of frames) {
    if (!r.iframe.isConnected) {
      frames.delete(r);
      continue;
    }
    if (r.iframe.contentWindow === e.source) {
      rec = r;
      break;
    }
  }
  const m = e.data;
  if (!rec || !m || m.__pb !== 1) return;
  // An app is isolated by the sandbox policy its page is served with, which makes its origin opaque. A frame
  // that isn’t isolated gets nothing from the bridge, and is shut.
  if (e.origin !== 'null') {
    console.error(`Postbox refused app “${rec.appId}”: its frame isn’t sandboxed.`);
    rec.iframe.src = 'about:blank';
    rec.onCrash?.();
    return;
  }
  const reply = (result, error) => e.source.postMessage({ __pb: 1, type: 'reply', id: m.id, result, error }, '*');
  const app = client.state.apps[rec.appId];
  const current = app && rec.version === app.current && !rec.check;
  switch (m.type) {
    case 'hello':
      e.source.postMessage({ __pb: 1, type: 'init', theme: theme(), state: rec.check ? null : (app?.state ?? null) }, '*');
      if (rec.review) e.source.postMessage({ __pb: 1, type: 'review', on: true }, '*');
      break;
    case 'size':
      rec.height = m.height;
      sizeFrame(rec);
      break;
    case 'lib':
      try {
        reply(await libSource(m.name));
      } catch (err) {
        reply(null, err.message);
      }
      break;
    case 'query':
      try {
        reply((await api(`/api/apps/${encodeURIComponent(rec.appId)}/query`, { tool: m.tool, args: m.args })).result);
      } catch (err) {
        reply(null, err.message);
      }
      break;
    case 'event':
      if (!current) return reply(null, rec.check ? 'Events are off during the check.' : 'This is an older version, shown read-only.');
      {
        const refused = activated(e, rec);
        if (refused) return reply(null, refused);
      }
      try {
        // Without per-frame activation (see SNAPSHOTS), every send waits for you on a card.
        const r = await api(`/api/apps/${encodeURIComponent(rec.appId)}/event`, {
          action: m.action,
          values: m.values,
          hold: !SNAPSHOTS || overLimit(rec.appId),
        });
        if (!r.held) countSent(rec.appId);
        reply(r);
      } catch (err) {
        reply(null, err.message);
        toast({ title: 'That didn’t reach the agent', text: err.message, level: 'blocking' });
      }
      break;
    case 'state':
      if (current) saveState(rec.appId, m.state);
      break;
    case 'anchors':
      rec.onAnchors?.(m.names);
      break;
    case 'pin':
      rec.onPin?.(m.anchor);
      break;
    case 'error':
      if (!rec.check && current) {
        crashes.set(`${rec.appId}:${rec.version}`, m.message);
        rec.onCrash?.();
      }
      break;
    case 'check': {
      const c = checks.get(`${rec.appId}:${rec.version}`);
      if (!c) return;
      c.results.set(m.width, m.problems);
      if (c.results.size === 2) finishCheck(rec.appId, rec.version);
      break;
    }
  }
});

// ── Sends in your voice (#38) ────────────────────────────────────────────────────────────
// An app’s postbox.send writes a line in your voice and starts an agent turn, so it counts only right after you
// click or press a key in that app. Two things have to hold, and the frame can vouch for neither:
//
// 1. The send carries a real gesture in that frame. The kit posts each send with includeUserActivation, and
//    Chrome attaches the sending frame’s own transient activation (a click or key press in that frame in the
//    last few seconds). It’s per frame: false for a frame that only focused itself, false after Tab into it,
//    and false five seconds later. The page’s own navigator.userActivation is no use: activation propagates up
//    to it (User Activation v2) from every frame and from the composer.
//
// 2. The frame got your keyboard rightfully. A frame can focus itself without a gesture (on load, while you type
//    in the composer, right after you click another app), and then your key presses really happen in it, which
//    passes 1. Measured in headless Chrome (tools/checks/app-send.mjs), the page sees no pointer events, and no
//    :hover, when the pointer moves over a frame, so it can’t tell a click into a frame from a steal. So frames
//    take no pointer events until the pointer is over them (CSS: iframe.app-iframe:not(.live)): over a frame,
//    the pointer is over this page, which sees it and makes that frame live. A frame may hold focus only if
//    it’s live (you pointed at it) or you tabbed into it. Any other frame that takes focus gives it straight
//    back, and is refused sends until you click or tab into it. One that keeps doing it (an app that autofocuses
//    a field does it once) is stopped, and shows a card to reload it: inert doesn’t stop a frame that runs in
//    its own process from taking focus (measured), so only unloading it does.
//
// A browser without MessageEvent.userActivation can’t do 1, so it fails closed: every send waits on a card.
const SNAPSHOTS = typeof MessageEvent !== 'undefined' && 'userActivation' in MessageEvent.prototype;
const NOT_ACTIVATED = 'Postbox sends an app’s message only right after the person clicks or presses a key in the app.';
const NOT_ENTERED = 'Postbox refused this app’s message: the app took the keyboard without the person clicking or tabbing into it.';

/** @type {HTMLIFrameElement | null} the app frame under the pointer */
let live = null;
/** @type {{ frame: HTMLIFrameElement, at: number } | null} the app frame a Tab key press is moving focus into */
let tabbing = null;
/** @type {HTMLIFrameElement | null} the app frame that holds focus, rightfully */
let owner = null;
/** @type {Element | null} the last element of this page that had focus */
let lastFocus = null;
const stolen = new WeakSet(); // frames that took focus on their own, refused until you click or tab into them
const steals = new WeakMap(); // frame → times it took focus on its own
const STEALS_TO_STOP = 3; // within STEAL_WINDOW_MS
const STEAL_WINDOW_MS = 10_000;
const stopped = new Set(); // `${appId}:${v}` stopped for taking focus, until you reload it

const appFrames = () => [...frames].filter((r) => r.iframe.isConnected).map((r) => r.iframe);
const isAppFrame = (el) => el instanceof HTMLIFrameElement && appFrames().includes(el);

function makeLive(f) {
  if (f === live) return;
  const was = live;
  live = f;
  f?.classList.add('live');
  if (was && was !== f) was.classList.remove('live');
}

/**
 * The app frame at a point of the window, if one is there and nothing of the page covers it. A frame that isn’t
 * live takes no pointer events, so the page finds the element around it (its .app-body) instead.
 * @param {number} x @param {number} y
 */
function frameAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const f = el instanceof HTMLIFrameElement ? el : el?.closest('.app-body')?.querySelector('iframe.app-iframe');
  if (!(f instanceof HTMLIFrameElement) || !isAppFrame(f)) return null;
  const r = f.getBoundingClientRect();
  return x >= r.left && x < r.right && y >= r.top && y < r.bottom ? f : null;
}

// Where the pointer last was on this page. It stays put while the page moves under it (a reply streaming in,
// the wheel, a message landing above), so an app that moves under a resting pointer becomes live, and one that
// moves away stops being live, without the pointer moving (#38). Inside a live frame the page doesn’t see the
// pointer move, so this is where it went in: close enough, and any move over the page corrects it.
/** @type {{ x: number, y: number } | null} */
let pointer = null;
function onPointer(e) {
  pointer = { x: e.clientX, y: e.clientY };
  makeLive(frameAt(e.clientX, e.clientY));
}
for (const type of ['pointermove', 'pointerover', 'pointerdown']) addEventListener(type, onPointer, true);

let relook = 0;
function relookSoon() {
  if (!pointer || relook) return;
  relook = requestAnimationFrame(() => {
    relook = 0;
    if (pointer) makeLive(frameAt(pointer.x, pointer.y));
  });
}
addEventListener('scroll', relookSoon, { capture: true, passive: true });
addEventListener('resize', relookSoon);
// The transcript renders, an item is added, or an app resizes: what’s under the pointer may have changed.
new MutationObserver(relookSoon).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

/** A frame took focus on its own: refused sends, and stopped if it keeps doing it. */
function steal(f) {
  stolen.add(f);
  const now = Date.now();
  const times = [...(steals.get(f) ?? []), now].filter((t) => now - t < STEAL_WINDOW_MS);
  steals.set(f, times);
  const rec = [...frames].find((r) => r.iframe === f);
  if (!rec || rec.check || times.length < STEALS_TO_STOP) return;
  stopped.add(`${rec.appId}:${rec.version}`);
  f.src = 'about:blank';
  rec.onCrash?.();
}

/** Where Tab or Shift+Tab goes from the focused element, if that’s an app frame. */
function tabTarget(back) {
  const all = [
    ...document.querySelectorAll('a[href], button, input, select, textarea, iframe.app-iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'),
  ].filter((el) => {
    if (!(el instanceof HTMLElement) || el.tabIndex < 0 || /** @type {any} */ (el).disabled) return false;
    if (!el.getClientRects().length || el.closest('[hidden]')) return false;
    return !el.parentElement?.closest('[inert]');
  });
  const i = all.indexOf(/** @type {HTMLElement} */ (document.activeElement));
  const next = all[i < 0 ? (back ? all.length - 1 : 0) : i + (back ? -1 : 1)];
  return isAppFrame(next) ? /** @type {HTMLIFrameElement} */ (next) : null;
}

addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Tab') return;
    const f = tabTarget(e.shiftKey);
    if (f) tabbing = { frame: f, at: Date.now() };
  },
  true,
);

/** Settles who has the keyboard. A frame that took focus on its own gives it back, and is paused. */
function checkFocus() {
  const a = document.activeElement;
  if (a && !(a instanceof HTMLIFrameElement) && a !== document.body) lastFocus = a;
  const f = a instanceof HTMLIFrameElement && (isAppFrame(a) || a.classList.contains('check-frame')) ? a : null;
  if (f === owner) return;
  owner = null;
  if (!f) return;
  const tabbed = tabbing?.frame === f && Date.now() - tabbing.at < 1000;
  if (f === live || tabbed) {
    owner = f;
    stolen.delete(f);
    tabbing = null;
    return;
  }
  if (lastFocus instanceof HTMLElement && lastFocus.isConnected) lastFocus.focus();
  else f.blur();
  steal(f);
}
addEventListener('blur', () => setTimeout(checkFocus, 0));
addEventListener('focusin', checkFocus);
// Focus moving from one frame to another tells this page nothing, so it also looks a few times a second.
setInterval(checkFocus, 100);

function activated(e, rec) {
  checkFocus();
  if (stolen.has(rec.iframe)) return NOT_ENTERED;
  if (SNAPSHOTS ? e.userActivation?.isActive !== true : navigator.userActivation?.isActive !== true || document.activeElement !== rec.iframe)
    return NOT_ACTIVATED;
  return null;
}

// At most SEND_LIMIT sends a minute per app go straight to the agent; past that, the server holds them on a card
// for you to allow. The server keeps the same limit (Runtime.APP_SEND_LIMIT) for anything calling its API.
// Only sends the server took straight through count, so a refused or held send doesn’t use up the minute.
const SEND_LIMIT = 5;
const SEND_WINDOW_MS = 60_000;
const sent = new Map(); // appId → times of sends that went straight through
function overLimit(appId, now = Date.now()) {
  const times = (sent.get(appId) ?? []).filter((t) => now - t < SEND_WINDOW_MS);
  sent.set(appId, times);
  return times.length >= SEND_LIMIT;
}
const countSent = (appId, now = Date.now()) => sent.set(appId, [...(sent.get(appId) ?? []), now]);

const pendingState = new Map();
function saveState(appId, state) {
  clearTimeout(pendingState.get(appId));
  pendingState.set(
    appId,
    setTimeout(() => api(`/api/apps/${encodeURIComponent(appId)}/state`, { state }).catch(() => {}), 400),
  );
}

function sizeFrame(rec) {
  if (!rec.iframe?.isConnected || rec.check) return;
  const h0 = Math.max(120, rec.height ?? 200);
  rec.iframe.style.height = `${expanded.has(rec.appId) || rec.review ? h0 : Math.min(h0, cap())}px`;
  rec.iframe.dataset.sized = '1';
  const body = rec.iframe.closest('.app-body');
  if (body) requestAnimationFrame(() => keyboardScroll(body));
}

/** When an app is taller than its box, the box scrolls, and the keyboard has to be able to scroll it too. */
function keyboardScroll(body) {
  if (body.scrollHeight > body.clientHeight + 1) {
    body.tabIndex = 0;
    body.setAttribute('aria-label', 'App, scrolls');
  } else {
    body.removeAttribute('tabindex');
    body.removeAttribute('aria-label');
  }
}

// A frame’s height is capped by the window’s, so a resized window resizes the frames with it.
let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const rec of frames) sizeFrame(rec);
  }, 100);
});

// ── Libraries for sandboxed pages ───────────────────────────────────────────────────────
// Apps and diagrams get the bundled libraries from here, as text, and run them inline (see kit.js). KaTeX’s
// fonts travel inside its stylesheet as data: URLs, since the page can’t fetch them either.
const LIB_FILES = { d3: 'd3/d3.min.js', katex: 'katex/katex.min.js', mermaid: 'mermaid/mermaid.min.js' };
const libCache = new Map();
function libSource(name) {
  if (!LIB_FILES[name]) return Promise.reject(new Error(`There’s no bundled library called “${name}”.`));
  if (!libCache.has(name)) {
    const text = (path) =>
      fetch(`/kit/vendor/${path}`).then((r) => {
        if (!r.ok) throw new Error(`Couldn’t load ${path}.`);
        return r;
      });
    const css =
      name === 'katex'
        ? text('katex/katex.min.css')
            .then((r) => r.text())
            .then(inlineFonts)
        : Promise.resolve(null);
    const p = Promise.all([text(LIB_FILES[name]).then((r) => r.text()), css]).then(([js, c]) => ({ js, css: c }));
    p.catch(() => libCache.delete(name));
    libCache.set(name, p);
  }
  return libCache.get(name);
}
async function inlineFonts(css) {
  const files = [...new Set([...css.matchAll(/url\(fonts\/([\w-]+\.woff2)\)/g)].map((m) => m[1]))];
  const data = new Map();
  await Promise.all(
    files.map(async (f) => {
      const buf = new Uint8Array(await (await fetch(`/kit/vendor/katex/fonts/${f}`)).arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      data.set(f, `data:font/woff2;base64,${btoa(bin)}`);
    }),
  );
  // Keep the woff2 source of each font face, as a data: URL, and drop the woff and ttf fallbacks.
  return css.replace(
    /url\(fonts\/([\w-]+)\.woff2\) format\("woff2"\)(?:,url\([^)]*\) format\("[^"]*"\))*/g,
    (_m, f) => `url(${data.get(`${f}.woff2`)}) format('woff2')`,
  );
}

export function onThemeChange() {
  for (const rec of frames) {
    if (!rec.iframe.isConnected) {
      frames.delete(rec);
      continue;
    }
    rec.iframe.contentWindow?.postMessage({ __pb: 1, type: 'theme', theme: theme() }, '*');
  }
  $$('.diagram iframe').forEach((f) => {
    f.src = f.src.replace(/theme=\w+/, `theme=${theme()}`);
  });
}

function frame(appId, version, { check = false, width = null, review = false, onPin, onAnchors, onCrash } = {}) {
  const app = client.state.apps[appId];
  const iframe = h('iframe', {
    class: check ? 'check-frame' : 'app-iframe',
    title: check ? `Checking ${app.title}` : app.title,
    // No sandbox attribute: the page’s own policy sandboxes it (see server/sandbox.mjs).
    referrerpolicy: 'no-referrer',
    'aria-hidden': check ? 'true' : null,
    tabindex: check ? '-1' : null,
    src: `/sandbox/app/${encodeURIComponent(appId)}/${version}?theme=${theme()}${check ? '&check' : ''}`,
    style: check ? { width: `${width}px` } : { height: '200px' },
  });
  // Messages are matched to this record by the frame’s window, so the kit’s first hello is never missed.
  frames.add({ appId, version, iframe, check, review, onPin, onAnchors, onCrash });
  return iframe;
}

// ── The pre-display check ────────────────────────────────────────────────────────────────

// ?nocheck turns off checks in this browser (a second, passive window such as a screenshot tool).
const NO_CHECK = new URLSearchParams(location.search).has('nocheck');

function startCheck(appId, version) {
  const key = `${appId}:${version}`;
  if (NO_CHECK || checks.has(key)) return;
  const c = { results: new Map(), frames: [] };
  checks.set(key, c);
  for (const w of [375, 1280]) {
    const f = frame(appId, version, { check: true, width: w });
    c.frames.push(f);
    document.body.append(f);
  }
  c.timer = setTimeout(() => {
    for (const w of [375, 1280])
      if (!c.results.has(w)) c.results.set(w, [{ code: 'no-answer', message: `The app didn’t finish loading within 10 seconds at ${w} px.` }]);
    finishCheck(appId, version);
  }, 10000);
}

function finishCheck(appId, version) {
  const key = `${appId}:${version}`;
  const c = checks.get(key);
  if (!c || c.done) return;
  c.done = true;
  clearTimeout(c.timer);
  for (const f of c.frames) f.remove();
  const seen = new Set();
  const problems = [...c.results.values()].flat().filter((p) => {
    const k = p.code + p.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  api(`/api/apps/${encodeURIComponent(appId)}/check`, { version, problems }).catch(() => {
    checks.delete(key);
  });
}

// ── App frames in the transcript ─────────────────────────────────────────────────────────

const observer = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      const id = en.target.dataset.appId;
      if (!id) continue;
      if (en.isIntersecting) {
        clearTimeout(en.target._unload);
        if (unloaded.delete(id)) en.target._remount?.();
      } else {
        // Far off screen for a moment: unload, keeping the same height so nothing jumps.
        clearTimeout(en.target._unload);
        en.target._unload = setTimeout(() => {
          if (!unloaded.has(id)) {
            unloaded.add(id);
            en.target._unmount?.();
          }
        }, 1500);
      }
    }
  },
  { rootMargin: '150% 0px 150% 0px' },
);

/**
 * Renders an app (current or viewed version) into `container`. Used by transcript items and app reviews.
 */
export function mountApp(container, appId, { review = false, onPin } = {}) {
  const app = client.state.apps[appId];
  if (!app) {
    container.replaceChildren(h('p.small.dim', 'This app isn’t available any more.'));
    return;
  }
  const v = viewing.get(appId) ?? app.current;
  const old = v !== app.current;
  const key = `${appId}:${v}`;
  const status = old || (reloaded.has(key) && app.check.status === 'crashed') ? 'passed' : app.check.status;
  const owner = client.state.sessions[app.sessionId]?.handle ?? 'the agent';
  const body = h('div.app-body', { dataset: { appId } });
  if (expanded.has(appId) || review) body.style.maxHeight = 'none';
  new ResizeObserver(() => keyboardScroll(body)).observe(body);
  const placeholder = (lines, height = 180, extra = null) => h('div.app-placeholder', { style: { height: `${height}px` } }, h('div.inner', lines, extra));
  const crashed = crashes.get(key);

  if (stopped.has(key)) {
    body.append(
      placeholder(
        [
          h('span.row-flex', { style: { color: 'var(--text)' } }, h('span.g.g-failed', { 'aria-hidden': 'true' }), h('b', `Postbox stopped ${app.title}`)),
          h('span', 'It kept taking the keyboard while you were using something else, so your typing could have gone to it. Its saved state is kept.'),
          h(
            'span.row-flex',
            h(
              'button.btn.sm',
              {
                type: 'button',
                onclick: () => {
                  stopped.delete(key);
                  mountApp(container, appId, { review, onPin });
                },
              },
              icon('retry', 'i-sm'),
              'Reload app',
            ),
          ),
        ],
        200,
      ),
    );
  } else if (crashed || status === 'crashed') {
    const msg = crashed ?? app.check.problems.find((p) => p.code === 'script-error')?.message ?? 'a script error';
    body.append(
      placeholder(
        [
          h('span.row-flex', { style: { color: 'var(--text)' } }, h('span.g.g-failed', { 'aria-hidden': 'true' }), h('b', `${app.title} stopped working`)),
          h('span', `It hit a script error and was shut down. Nothing outside the app was affected. Reload it, or ask @${owner} to fix it.`),
          h('code.mono', { style: { color: 'var(--text)' } }, msg),
          h(
            'span.row-flex',
            h(
              'button.btn.sm',
              {
                type: 'button',
                onclick: () => {
                  crashes.delete(key);
                  reloaded.add(key);
                  mountApp(container, appId, { review, onPin });
                },
              },
              icon('retry', 'i-sm'),
              'Reload app',
            ),
            h('button.btn.sm', { type: 'button', onclick: () => askToFix(app, msg) }, `Ask @${owner} to fix it`),
          ),
        ],
        220,
      ),
    );
  } else if (status === 'pending') {
    startCheck(appId, v);
    body.append(
      placeholder([
        h(
          'span.row-flex',
          h('span.g.g-running', { 'aria-hidden': 'true' }),
          h('b', { style: { color: 'var(--text)', fontWeight: 500 } }, 'Checking the app before showing it…'),
        ),
        h('span', 'Contrast, layout at phone and desktop widths, labels, and keyboard order.'),
      ]),
    );
  } else if (status === 'fixing') {
    body.append(
      placeholder(
        [
          h(
            'span.row-flex',
            h('span.g.g-running', { 'aria-hidden': 'true' }),
            h('b', { style: { color: 'var(--text)', fontWeight: 500 } }, `@${owner} is fixing a problem the check found`),
          ),
          h('span', app.check.problems.map((p) => p.message).join(' ')),
          h('span', 'The fixed version appears here.'),
        ],
        200,
      ),
    );
  } else {
    const mount = () => {
      const f = frame(appId, v, { review, onPin, onCrash: () => mountApp(container, appId, { review, onPin }) });
      body.replaceChildren(f);
      return f;
    };
    mount();
    body._remount = () => mount();
    body._unmount = () => {
      const hgt = body.firstElementChild?.offsetHeight || 200;
      body.replaceChildren(
        placeholder(
          [
            h('span.row-flex', h('b', { style: { color: 'var(--text)', fontWeight: 500 } }, 'Unloaded while off screen')),
            h('span', 'It reloads from its saved state as you scroll near it.'),
          ],
          hgt,
        ),
      );
    };
    if (!review) observer.observe(body);
  }

  const notes = [];
  if (old)
    notes.push(
      h(
        'div.app-note',
        icon('clock'),
        h(
          'span',
          `Viewing v${v}, read-only. `,
          h(
            'button.btn.sm.ghost',
            {
              type: 'button',
              onclick: () => {
                viewing.delete(appId);
                mountApp(container, appId, { review, onPin });
              },
            },
            `Back to v${app.current}`,
          ),
        ),
      ),
    );
  if (!old && status === 'note')
    notes.push(h('div.app-note', icon('warn'), h('span', `Shown with problems @${owner} couldn’t fix: ${app.check.problems.map((p) => p.message).join(' ')}`)));
  container.replaceChildren(...notes, body);
}

function askToFix(app, msg) {
  const se = client.state.sessions[app.sessionId];
  if (!se) return;
  api(`/api/threads/${app.threadId}/messages`, { text: `@${se.handle} the ${app.title} app stopped working: \`${msg}\`. Please fix it.` }).catch((e) =>
    toast({ title: 'That didn’t send', text: e.message, level: 'blocking' }),
  );
}

/** The whole app frame for a transcript item. */
export function renderAppItem(item, ctx) {
  const app = client.state.apps[item.block.id];
  if (!app) return h('div.block', h('div.block-body', h('p.dim', 'This app was removed.')));
  const holder = h('div');
  const v = viewing.get(app.id) ?? app.current;
  const last = app.versions[app.current - 1];
  const versionBtn = h(
    'button.btn.sm',
    {
      type: 'button',
      'aria-haspopup': 'menu',
      onclick: (e) =>
        openMenu(
          e.currentTarget,
          [
            { heading: 'Versions' },
            ...[...app.versions].reverse().map((ver) => ({
              label: `v${ver.v}${ver.summary ? ` · ${ver.summary}` : ver.v === 1 ? ' · first version' : ''}`,
              desc: `${ago(ver.at)}${ver.v === app.current ? ' · current' + (app.state ? ' · your state carried over' : '') : ' · view read-only'}`,
              icon: ver.v === v ? 'check' : null,
              run: () => {
                if (ver.v === app.current) viewing.delete(app.id);
                else viewing.set(app.id, ver.v);
                ctx.rerender();
              },
            })),
          ],
          { label: 'Versions' },
        ),
    },
    `v${app.current} · updated ${ago(last.at)}`,
    icon('down', 'i-sm'),
  );
  const expandBtn = h(
    'button.btn.icon.sm',
    {
      type: 'button',
      'aria-label': expanded.has(app.id) ? 'Collapse' : 'Expand',
      'aria-pressed': String(expanded.has(app.id)),
      onclick: () => {
        if (expanded.has(app.id)) expanded.delete(app.id);
        else expanded.add(app.id);
        ctx.rerender();
      },
    },
    icon('expand'),
  );
  const titleId = `app-${app.id}`;
  const node = h(
    'section.wide.appframe',
    { 'aria-labelledby': titleId },
    h('div.app-bar', h('span.title', { id: titleId }, app.title), h('span.authored', 'Agent-written app'), h('span.grow'), versionBtn, expandBtn),
    holder,
  );
  mountApp(holder, app.id);
  return node;
}

// ── An app’s sends waiting for you ───────────────────────────────────────────────────────
// Past the limit, an app’s sends wait on this card (the server’s appsend item). Postbox draws it, like the
// permission and refusal cards: Allow sends them to the agent as they were sent, Don’t allow drops them.
export function renderAppSendCard(it, ctx) {
  const open = it.status === 'open';
  const n = it.events.length;
  // One answer: the buttons turn off at the first press (a double click would answer twice), and back on if it
  // didn’t go through. Then focus goes to the composer of the thread the card is in, a panel’s or the main one.
  /** @param {string} action @param {MouseEvent} e */
  const act = (action, e) => {
    const card = /** @type {HTMLElement} */ (e.currentTarget).closest('.appsend');
    const buttons = [...(card?.querySelectorAll('button') ?? [])];
    for (const b of buttons) b.disabled = true;
    const composer = card?.closest('.sidepanel') ? document.getElementById('side-input') : document.getElementById('composer-input');
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action })
      .then(() => composer?.focus())
      .catch((err) => {
        for (const b of buttons) b.disabled = false;
        toast({ title: 'That didn’t go through', text: err.message, level: 'blocking' });
      });
  };
  const titleId = `as-${it.id}`;
  return h(
    'div.col.block.appsend',
    { role: 'group', 'aria-labelledby': titleId, class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
    h(
      'div.block-head',
      open ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
      h(
        'span.title.grow',
        { id: titleId },
        open ? `${it.title} wants to send ${plural(n, 'message')} for you` : `${it.title} asked to send ${plural(n, 'message')} for you`,
      ),
      h('span.kind', 'Approve · from Postbox'),
    ),
    h(
      'div.block-body',
      open
        ? h(
            'p.small',
            `An app can send up to ${SEND_LIMIT} messages a minute in your voice. These came after that, so they wait for you. Each one starts a turn for the agent.`,
          )
        : null,
      h(
        'ul.appsend-list',
        it.events.map((ev) => h('li', ev.voice)),
      ),
      !open
        ? h(
            'span.answered-note',
            icon(it.status === 'allowed' ? 'check' : 'x', 'i-sm'),
            it.status === 'allowed' ? `Allowed. ${n === 1 ? 'It was' : 'They were'} sent.` : `Not allowed. ${n === 1 ? 'It wasn’t' : 'They weren’t'} sent.`,
          )
        : null,
    ),
    open
      ? h(
          'div.block-foot',
          h('button.btn', { type: 'button', onclick: (e) => act('allow', e) }, 'Allow'),
          h('button.btn', { type: 'button', onclick: (e) => act('deny', e) }, 'Don’t allow'),
        )
      : null,
  );
}

// ── Diagrams and math in messages ────────────────────────────────────────────────────────

export function enhanceMarkdown(root) {
  for (const fig of root.querySelectorAll('figure.md-mermaid:not(.done)')) {
    fig.classList.add('done');
    const src = fig.textContent;
    const pre = h('pre.mono', { hidden: true }, src);
    // Sandboxed by the policy the page is served with, like the apps.
    const iframe = h('iframe', { title: 'Diagram', src: `/sandbox/mermaid?theme=${theme()}`, referrerpolicy: 'no-referrer' });
    const btn = h(
      'button.btn.sm.ghost',
      {
        type: 'button',
        'aria-expanded': 'false',
        onclick: () => {
          pre.hidden = !pre.hidden;
          btn.textContent = pre.hidden ? 'Show source' : 'Hide source';
          btn.setAttribute('aria-expanded', String(!pre.hidden));
        },
      },
      'Show source',
    );
    const box = h('figure.diagram', h('div.d-bar', h('span.label.grow', 'Diagram'), btn), iframe, pre);
    fig.replaceWith(box);
    const onMsg = (e) => {
      if (e.source !== iframe.contentWindow || e.data?.__pbd !== 1 || e.origin !== 'null') return;
      if (e.data.type === 'ready')
        libSource('mermaid').then(({ js }) => iframe.contentWindow?.postMessage({ __pbd: 1, type: 'render', src, label: 'Diagram', lib: js }, '*'));
      if (e.data.type === 'error') console.error(`Diagram: ${e.data.message}`);
      if (e.data.type === 'size') {
        iframe.style.height = `${Math.min(e.data.height, 900)}px`;
        iframe.dataset.sized = '1';
        // Too small to read: tell the server, once per diagram, so the agent can redraw it.
        if (typeof e.data.textPx === 'number') iframe.dataset.textPx = String(e.data.textPx);
        const itemEl = box.closest('[data-key]');
        const threadId = box.closest('[data-thread]')?.dataset.thread;
        if (e.data.textPx < MIN_TEXT_PX && itemEl && threadId && !iframe.dataset.reported) {
          iframe.dataset.reported = '1';
          api(`/api/threads/${threadId}/items/${itemEl.dataset.key}/diagram`, { src, textPx: e.data.textPx, width: e.data.width }).catch(() => {});
        }
      }
      if (!iframe.isConnected) removeEventListener('message', onMsg);
    };
    addEventListener('message', onMsg);
  }
  const math = root.querySelectorAll('.md-math:not(.rendered)');
  if (math.length)
    loadKatex()
      .then((katex) => {
        for (const el of math) {
          const tex = el.textContent;
          try {
            katex.render(tex, el, { displayMode: el.dataset.display === 'true', throwOnError: false, trust: false, strict: 'ignore' });
            // KaTeX writes MathML beside the visual math, which is what screen readers read.
            el.classList.add('rendered');
            // A wide formula scrolls sideways in a narrow column; the keyboard has to be able to scroll it too.
            if (el.dataset.display === 'true')
              requestAnimationFrame(() => {
                if (el.scrollWidth > el.clientWidth + 1) el.tabIndex = 0;
              });
          } catch {
            /* leave the source visible */
          }
        }
      })
      .catch(() => {});
}

let katexP = null;
function loadKatex() {
  katexP ??= new Promise((resolve, reject) => {
    document.head.append(h('link', { rel: 'stylesheet', href: '/kit/vendor/katex/katex.min.css' }));
    const s = h('script', { src: '/kit/vendor/katex/katex.min.js' });
    s.onload = () => resolve(window.katex);
    s.onerror = reject;
    document.head.append(s);
  });
  return katexP;
}

addEventListener('resize', () => {
  for (const rec of frames.values()) sizeFrame(rec);
});
