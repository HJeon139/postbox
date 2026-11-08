// Agent-written apps on the host side: sandboxed frames, the bridge, the pre-display check, versions,
// review mode, full screen, and unloading far-off-screen frames (they reload from saved state as you approach).
// Diagrams and math in messages are md-enhance.mjs's; the bundled libraries both use are sandbox-libs.mjs's.

import { afterAppChecks, appChecksRunning, installAppChecks, recordAppCheck } from './app-check.mjs';
import { crashCard, errorStrip } from './app-crash.mjs';
import { live, nearBodies, relookSoon, setAppFrameTest } from './app-pointer.mjs';
import { renderAppSendCard, SEND_LIMIT } from './app-send-card.mjs';
import { api, client, placeIn } from './client.mjs';
import { $$, ago, h, icon } from './dom.mjs';
import { goToItem } from './go-to-item.mjs';
import { libSource, theme } from './sandbox-libs.mjs';
import { nextTabStop } from './tab-stop.mjs';
import { openMenu, toast } from './ui.mjs';

export { enhanceMarkdown } from './md-enhance.mjs';
export { renderAppSendCard };

const frames = new Set(); // { appId, version, iframe, check, review, onPin, onAnchors, onCrash, onError }
const madeFrames = new WeakSet(); // every iframe frame() made, for isAppFrame
const bodies = new Set(); // every .app-body mountApp made, until releaseApps finds it gone from the page
const crashes = new Map(); // `${appId}:${v}` → message (a script error after the app was shown)
const reloaded = new Set(); // `${appId}:${v}` you chose Reload for after its check crashed: run it, don’t show the crash again
const viewing = new Map(); // appId → an older version you’re looking at, read-only
const unloaded = new Set(); // appIds whose frames are unloaded while off screen
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
  const current = app && !app.retired && rec.version === app.current && !rec.check;
  switch (m.type) {
    case 'hello':
      e.source.postMessage({ __pb: 1, type: 'init', theme: theme(), state: rec.check ? null : (app?.state ?? null) }, '*');
      if (rec.review) e.source.postMessage({ __pb: 1, type: 'review', on: true }, '*');
      break;
    case 'size':
      // Full screen, the frame is the window’s height, so the app measures at least that; keep the height it
      // had in the column for when it comes back, and ask it to measure again then (see exitFull).
      if (!isFull(rec)) rec.height = m.height;
      sizeFrame(rec);
      break;
    case 'escape':
      // Escape pressed inside the app, where this page doesn’t hear it. All an app can do with this is leave full screen.
      if (full?.appId === rec.appId && isFull(rec)) exitFull();
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
    case 'file':
      // A data file of the version this frame runs (#54); the check’s frame reads it too, as the app will.
      try {
        const r = await fetch(`/api/apps/${encodeURIComponent(rec.appId)}/files/${encodeURIComponent(String(m.name))}?v=${rec.version}`);
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Postbox couldn’t read the file “${m.name}”.`);
        reply(await r.text());
      } catch (err) {
        reply(null, err.message);
      }
      break;
    case 'event':
      if (!current)
        return reply(
          null,
          rec.check
            ? 'Events are off during the check.'
            : app?.retired
              ? 'This app was retired, so it’s shown read-only.'
              : 'This is an older version, shown read-only.',
        );
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
      // An app that has drawn keeps running and shows the error under it; one that drew nothing is shut (#964).
      if (!rec.check && current && m.drawn) rec.onError?.(m.message);
      else if (!rec.check && current) {
        crashes.set(`${rec.appId}:${rec.version}`, m.message);
        rec.onCrash?.();
      }
      break;
    case 'check':
      recordAppCheck(rec.appId, rec.version, m.width, m.problems);
      break;
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
//    passes 1. Measured in headless Chrome (tests/browser/app-send.spec.mjs), the page sees no pointer events, and no
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

const isAppFrame = (el) => el instanceof HTMLIFrameElement && madeFrames.has(el) && el.isConnected;
setAppFrameTest(isAppFrame);

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

/** Where Tab or Shift+Tab goes from the focused element, if that’s an app frame. @param {boolean} back */
function tabTarget(back) {
  const next = nextTabStop(back);
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
  // Full screen, CSS sizes the frame to the overlay.
  rec.iframe.style.height = isFull(rec) ? '100%' : `${rec.review ? h0 : Math.min(h0, cap())}px`;
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
    for (const rec of frames) sizeFrame(rec); // sizeFrame skips a check frame itself
  }, 100);
});

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

function frame(appId, version, { check = false, width = null, height = null, view = false, review = false, onPin, onAnchors, onCrash, onError } = {}) {
  const app = client.state.apps[appId];
  const iframe = h('iframe', {
    class: check ? 'check-frame' : 'app-iframe',
    title: check ? `Checking ${app.title}` : app.title,
    // No sandbox attribute: the page’s own policy sandboxes it (see server/sandbox.mjs).
    referrerpolicy: 'no-referrer',
    'aria-hidden': check ? 'true' : null,
    tabindex: check ? '-1' : null,
    src: `/sandbox/app/${encodeURIComponent(appId)}/${version}?theme=${theme()}${check ? '&check' : ''}${view ? '&view' : ''}`,
    style: check ? { width: `${width}px`, ...(height ? { height: `${height}px` } : {}) } : { height: '200px' },
  });
  // Messages are matched to this record by the frame’s window, so the kit’s first hello is never missed.
  frames.add({ appId, version, iframe, check, review, onPin, onAnchors, onCrash, onError });
  madeFrames.add(iframe);
  return iframe;
}
const isOnScreen = (iframe) => {
  const rect = iframe.getBoundingClientRect();
  return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
};
function pauseAppFrames() {
  const bodies = new Set();
  for (const rec of frames) {
    // Never interrupt a frame the person can see, points at, or uses with the keyboard (#37).
    if (rec.check || !rec.iframe.isConnected || isOnScreen(rec.iframe) || rec.iframe === live || rec.iframe === owner) continue;
    const body = rec.iframe.closest('.app-body');
    if (body?._unmount) {
      bodies.add(body);
      body._unmount('checking');
    }
  }
  return bodies;
}

function resumeAppFrames(bodies) {
  for (const body of bodies) if (body.isConnected && !unloaded.has(body.dataset.appId)) body._remount?.();
}

function mountAfterChecks(body, mount, placeholder) {
  const deferred = () => body.isConnected && mount();
  if (appChecksRunning()) {
    body.append(placeholder([h('span', 'Waiting for another app’s check to finish…')]));
    afterAppChecks(deferred);
  } else mount();
  body._remount = () => (appChecksRunning() ? afterAppChecks(deferred) : mount());
}

function pausedApp(placeholder, reason, height) {
  const checking = reason === 'checking';
  return placeholder(
    [
      h(
        'span.row-flex',
        h('b', { style: { color: 'var(--text)', fontWeight: 500 } }, checking ? 'Paused while another app is checked' : 'Unloaded while off screen'),
      ),
      h('span', checking ? 'It resumes when the check finishes. Its saved state is kept.' : 'It reloads from its saved state as you scroll near it.'),
    ],
    height,
  );
}

installAppChecks(frame, { pause: pauseAppFrames, resume: resumeAppFrames });

// ── App frames in the transcript ─────────────────────────────────────────────────────────

const observer = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      const id = en.target.dataset.appId;
      if (!id) continue;
      if (en.isIntersecting) {
        nearBodies.add(en.target);
        relookSoon();
        clearTimeout(en.target._unload);
        if (unloaded.delete(id)) en.target._remount?.();
      } else {
        nearBodies.delete(en.target);
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
// One for every app body: an app taller than its box makes the box scroll.
const bodySizes = new ResizeObserver((entries) => {
  for (const en of entries) keyboardScroll(en.target);
});

/**
 * Lets go of the apps of a view that’s gone (#930): a view’s destroy queues it, so it runs once the view’s elements
 * have left the page. A frame no longer on the page leaves `frames`, and a body no longer on it stops being watched.
 */
export function releaseApps() {
  for (const rec of frames) if (!rec.iframe.isConnected) frames.delete(rec);
  for (const body of bodies) {
    if (body.isConnected) continue;
    bodies.delete(body);
    observer.unobserve(body);
    bodySizes.unobserve(body);
    nearBodies.delete(body);
  }
}

/** A new app body, watched for its size, and for nearness unless it’s a review’s. */
function appBody(appId, review) {
  const body = h('div.app-body', { dataset: { appId } });
  bodies.add(body);
  bodySizes.observe(body);
  // A review never unloads, so it isn’t watched for nearness: while it’s mounted, its app may be under the pointer.
  if (review) {
    // Its old bodies leave the near set in mayBeUnder(), not here: releaseApps() now would run before the transcript
    // is attached, and let go of apps above it that aren’t on the page yet (the integrator’s read of #993).
    body.style.maxHeight = 'none';
    nearBodies.add(body);
  }
  return body;
}

/**
 * Renders an app (current or viewed version) into `container`. Used by transcript items and app reviews.
 */
export function mountApp(container, appId, { review = false, onPin, onBack } = {}) {
  const app = client.state.apps[appId];
  if (!app) {
    container.replaceChildren(h('p.small.dim', 'This app isn’t available any more.'));
    return;
  }
  const v = viewing.get(appId) ?? app.current;
  const old = v !== app.current || !!app.retired; // a retired app’s versions open read-only, the current one too, unchecked (#193)
  const key = `${appId}:${v}`;
  const status = old || (reloaded.has(key) && app.check.status === 'crashed') ? 'passed' : app.check.status;
  const owner = client.state.sessions[app.sessionId]?.handle ?? 'the agent';
  const body = appBody(appId, review);
  const placeholder = (lines, height = 180, extra = null) => h('div.app-placeholder', { style: { height: `${height}px` } }, h('div.inner', lines, extra));
  const crashed = crashes.get(key);
  /** @type {ReturnType<typeof errorStrip> | null} */
  let strip = null;

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
                  mountApp(container, appId, { review, onPin, onBack });
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
    const reload = () => {
      crashes.delete(key);
      reloaded.add(key);
      mountApp(container, appId, { review, onPin, onBack });
    };
    body.append(crashCard(placeholder, { app, owner, msg, reload }));
  } else if (status === 'pending') {
    body.append(
      placeholder([
        h(
          'span.row-flex',
          h('span.g.g-running', { 'aria-hidden': 'true' }),
          h('b', { style: { color: 'var(--text)', fontWeight: 500 } }, 'Checking the app before showing it…'),
        ),
        h('span', 'Contrast, layout in narrow and wide windows, labels, and keyboard order.'),
      ]),
    );
  } else if (status === 'fixing') {
    body.append(
      placeholder(
        [
          h(
            'span.row-flex',
            h('span.g.g-running', { 'aria-hidden': 'true' }),
            h('b', { style: { color: 'var(--text)', fontWeight: 500 } }, `${owner} is fixing a problem the check found`),
          ),
          h('span', app.check.problems.map((p) => p.message).join(' ')),
          h('span', 'The fixed version appears here.'),
        ],
        200,
      ),
    );
  } else {
    const remount = () => mountApp(container, appId, { review, onPin, onBack });
    strip = errorStrip({ app, owner, reload: remount });
    const mount = () => body.replaceChildren(frame(appId, v, { review, onPin, onCrash: remount, onError: strip.show }));
    mountAfterChecks(body, mount, placeholder);
    body._unmount = (reason = 'offscreen') => {
      body.replaceChildren(pausedApp(placeholder, reason, body.firstElementChild?.offsetHeight || 200));
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
              // A retired app in a review has no line to go back to.
              hidden: !!app.retired && !onBack,
              onclick: () => {
                viewing.delete(appId);
                (onBack ?? (() => mountApp(container, appId, { review, onPin, onBack })))();
              },
            },
            onBack ? 'Close' : `Back to v${app.current}`,
          ),
        ),
      ),
    );
  if (!old && status === 'note')
    notes.push(
      h(
        'div.app-note',
        icon('warn'),
        h(
          'span',
          // Warnings only (marks or text too small, say): the app passed and is shown, and @owner was told.
          `${app.check.notes ? `Shown with notes for ${owner}` : `Shown with problems ${owner} couldn’t fix`}: ${app.check.problems.map((p) => p.message).join(' ')}`,
        ),
      ),
    );
  container.replaceChildren(...notes, body, ...(strip ? [strip.el] : []));
}

/** The whole app frame for a transcript item. */
export function renderAppItem(item, ctx) {
  const app = client.state.apps[item.block.id];
  if (!app) return h('div.block', h('div.block-body', h('p.dim', 'This app was removed.')));
  const holder = h('div.app-holder');
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
              // Opens on the version shown, scrolled into view among many (#36).
              current: ver.v === v,
              run: () => {
                if (ver.v === app.current && !app.retired) viewing.delete(app.id);
                else viewing.set(app.id, ver.v);
                ctx.rerender();
              },
            })),
          ],
          { label: 'Versions', className: 'versions' },
        ),
    },
    `v${app.current} · updated ${ago(last.at)}`,
    icon('down', 'i-sm'),
  );
  // Retired (#193): one line in its place, and no sandbox until you open a version from its menu.
  if (app.retired && !viewing.has(app.id)) {
    if (full?.appId === app.id) exitFull({ focus: false });
    return retiredLine(app, versionBtn, ctx);
  }
  const titleId = `app-${app.id}`;
  const fullBtn = h('button.btn.icon.sm', { type: 'button', 'aria-label': 'Full screen' }, icon('expand'));
  const node = h(
    'section.wide.appframe',
    { 'aria-labelledby': titleId },
    h('div.app-bar', h('span.title', { id: titleId }, app.title), h('span.authored', 'Agent-written app'), h('span.grow'), versionBtn, fullBtn),
    holder,
  );
  // The overlay is this same box, fixed over the window: the frame never moves in the DOM, so it doesn’t reload.
  const overlay = h('div.app-full', node);
  const slot = h('div.app-slot', overlay);
  const rec = { appId: app.id, slot, overlay, btn: fullBtn, titleId };
  fullBtn.onclick = () => (full?.overlay === overlay ? exitFull() : enterFull(rec));
  // Close goes back to a retired app’s line, out of full screen, with focus on its version menu.
  const back = () => {
    if (full?.appId === app.id) exitFull({ focus: false });
    ctx.rerender();
    document.querySelector(`[data-key="${CSS.escape(item.id)}"] .app-retired [aria-haspopup]`)?.focus();
  };
  mountApp(holder, app.id, app.retired ? { onBack: back } : {});
  // Re-rendered while full screen (another version, say): the new box takes the old one’s place.
  // (Only a re-render: the old box is still on the page. Coming back to the conversation later starts in the column.)
  if (full && !full.overlay.isConnected) exitFull({ focus: false });
  if (full?.appId === app.id)
    queueMicrotask(() => {
      if (!slot.isConnected) return;
      const refocus = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
      if (full) full.slot.style.minHeight = '';
      full = null;
      enterFull(rec, { focus: refocus });
    });
  return slot;
}

/**
 * A retired app (#193): one quiet line where it was, saying who retired it and why, with a link to what replaced it
 * when that’s shown in this conversation, and its version menu.
 */
function retiredLine(app, versionBtn, ctx) {
  const r = app.retired;
  const to = r.replacedBy && placeIn(ctx.threadId, r.replacedBy.itemId) >= 0 ? r.replacedBy : null;
  const goTo = (e) => goToItem(e, to.itemId);
  return h(
    'div.col.sys-line.app-retired',
    { role: 'group', 'aria-label': `${app.title}, retired` },
    icon('archive', 'i-sm'),
    h('span.grow', h('b', app.title), ` · Retired by ${r.by}: ${r.reason}`),
    to ? h('button.btn.sm.ghost', { type: 'button', onclick: goTo }, `Go to ${to.title}`) : null,
    versionBtn,
  );
}

// ── Full screen ──────────────────────────────────────────────────────────────────────────
// One app at a time fills the window. Its box is fixed over the page (class “fullscreen”), its slot keeps the
// column’s height so nothing jumps, and the frame fills the box. It closes with Escape (pressed here, or inside
// the app, which the kit passes on) or with the same button, now “Exit full screen”, and focus goes back to it.

/** @type {{ appId: string, slot: HTMLElement, overlay: HTMLElement, btn: HTMLElement, titleId: string } | null} */
let full = null;
const isFull = (rec) => !!rec.iframe?.closest('.fullscreen');

function framesOf(appId) {
  return [...frames].filter((r) => r.appId === appId && !r.check && r.iframe.isConnected);
}

function enterFull(rec, { focus = true } = {}) {
  if (full) exitFull({ focus: false });
  full = rec;
  rec.slot.style.minHeight = `${rec.slot.offsetHeight}px`;
  rec.overlay.classList.add('fullscreen');
  rec.overlay.setAttribute('role', 'dialog');
  rec.overlay.setAttribute('aria-modal', 'true');
  rec.overlay.setAttribute('aria-labelledby', rec.titleId);
  rec.btn.setAttribute('aria-label', 'Exit full screen');
  for (const f of framesOf(rec.appId)) sizeFrame(f);
  if (focus) rec.btn.focus();
}

function exitFull({ focus = true } = {}) {
  const rec = full;
  if (!rec) return;
  full = null;
  rec.overlay.classList.remove('fullscreen');
  for (const a of ['role', 'aria-modal', 'aria-labelledby']) rec.overlay.removeAttribute(a);
  rec.btn.setAttribute('aria-label', 'Full screen');
  rec.slot.style.minHeight = '';
  for (const f of framesOf(rec.appId)) {
    sizeFrame(f);
    // Its size messages were the window’s while full screen; it measures again at its column height.
    f.iframe.contentWindow?.postMessage({ __pb: 1, type: 'measure', height: parseFloat(f.iframe.style.height) }, '*');
  }
  if (focus && rec.btn.isConnected) rec.btn.focus();
}

addEventListener(
  'keydown',
  (e) => {
    if (!full || e.key !== 'Escape') return;
    // The view it was in is gone (you went to another page): it isn’t full screen any more.
    if (!full.overlay.isConnected) return exitFull({ focus: false });
    // A menu or a sheet open over the app closes first.
    if (e.defaultPrevented || (e.target instanceof Element && e.target.closest('.menu, .backdrop'))) return;
    e.preventDefault();
    exitFull();
  },
  true,
);

// Keep focus inside while full screen: Tab past the end comes back to the start, and Shift+Tab before the
// start goes to the app. Menus, sheets and toasts opened from it are outside the box, and keep focus.
addEventListener('focusin', (e) => {
  if (!full || !(e.target instanceof Element)) return;
  if (!full.overlay.isConnected) return exitFull({ focus: false });
  if (full.overlay.contains(e.target) || e.target.closest('.menu, .backdrop, .toasts')) return;
  const before = full.overlay.compareDocumentPosition(e.target) & Node.DOCUMENT_POSITION_PRECEDING;
  const inside = [...full.overlay.querySelectorAll('button, iframe, [tabindex="0"]')];
  const to = /** @type {HTMLElement | undefined} */ (before ? inside.at(-1) : inside[0]);
  // A keyboard move into the app, like Tab: it may take focus (see checkFocus).
  if (to instanceof HTMLIFrameElement) tabbing = { frame: to, at: Date.now() };
  to?.focus();
});

addEventListener('resize', () => {
  for (const rec of frames) sizeFrame(rec); // sizeFrame skips a check frame itself
});
