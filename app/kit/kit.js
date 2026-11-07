// The app kit, preloaded in every agent-app sandbox. It gives agent code:
//   postbox.ready                 → Promise<{ state, theme, appId }>, resolves once Postbox says hello
//   postbox.query(tool, args)     → Promise<result>; only tools the app and its agent were granted
//   postbox.file(name)            → Promise<string>; a data file the agent attached to this version (#54)
//   postbox.send(action, values, summary)  sends one event to the agent. Postbox writes the line in your voice from
//                                 what was sent; summary shows beside it as the app’s own words (#51). Only
//                                 right after the person clicks or presses a key in the app (it rejects
//                                 otherwise), up to 5 a minute; more resolve { held: true, waiting } and wait
//                                 for the person to allow them on a card. Don’t focus anything on load: an
//                                 app that takes the keyboard without a click gets it taken back. Values larger
//                                 than one event carries (eventBytes in shared/limits.mjs, which the server
//                                 passes in data-init) reject here, with the limit named, and nothing is sent
//   postbox.saveState(obj) / postbox.restoreState()   survives unload, reload and new versions
//   postbox.anchors({ name: element })   parts you can pin review comments to
//   postbox.on('theme', fn)       called when light/dark changes (tokens update by themselves)
//   postbox.load('d3' | 'katex' | 'mermaid')   loads a bundled library
//   postbox.charts.line / scatter / stacked / heatmap / table   charts that follow Workbench’s rules. Colors:
//                                 the chart palettes and the status-only colors, with when to use each, are
//                                 PALETTES in shared/limits.mjs, which the guide gives agents; these charts use
//                                 --s1…--s8 for series and --seq-* for heatmaps
//   postbox.graph(el, { nodes, edges, groups?, highlight? })   → Promise<layout>; a network laid out by d3-force, with
//                                 groups as soft regions, labels that never overlap and a Table view (app/kit/graph.js)
//   postbox.narrate(text, { voice, speed })   → Promise<{ url, ms }>, a clip read aloud by Postbox’s local voice
//   postbox.narration(el, passages, { voice, speed, onPassage })   a player with a transcript that follows along
// It also reports size changes and script errors to Postbox, and runs the pre-display check.
(function () {
  const me = document.currentScript;
  const init = JSON.parse(me.dataset.init || '{}');
  const pending = new Map();
  const listeners = { theme: [] };
  const errors = [...(init.syntaxErrors ?? [])];
  let seq = 0;
  let resolveReady;
  const ready = new Promise((r) => {
    resolveReady = r;
  });
  let anchorMap = {};
  let reviewing = false;

  // includeUserActivation: the browser attaches this frame’s own click or key press state to the message, which
  // is how Postbox knows a send came from the person using the app (the app can’t set it itself).
  const post = (msg) =>
    parent.postMessage(Object.assign({ __pb: 1, appId: init.appId, version: init.version }, msg), { targetOrigin: '*', includeUserActivation: true });
  const call = (type, payload) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      post(Object.assign({ type, id }, payload));
    });

  addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (m?.__pb !== 1) return;
    if (m.type === 'init') {
      document.documentElement.dataset.theme = m.theme;
      resolveReady({ state: init.check ? null : (m.state ?? null), theme: m.theme, appId: init.appId });
    } else if (m.type === 'theme') {
      document.documentElement.dataset.theme = m.theme;
      for (const fn of listeners.theme)
        try {
          fn(m.theme);
        } catch (err) {
          report(err);
        }
    } else if (m.type === 'reply') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
    } else if (m.type === 'review') {
      reviewing = !!m.on;
      paintAnchors();
    } else if (m.type === 'measure') {
      // Back from full screen. The last size sent was the window’s, so measure again, once the frame is back to
      // its column height (it resizes a moment after this message).
      let tries = 0;
      const wait = () => {
        if (Math.abs(innerHeight - m.height) < 2 || ++tries > 60) {
          lastH = 0;
          sizeNow();
        } else requestAnimationFrame(wait);
      };
      requestAnimationFrame(wait);
    }
  });
  function report(err, source) {
    const detail = err?.name && err?.message ? `${err.name}: ${err.message}` : String(err?.message || err);
    const message = detail + (source?.lineno ? ` (line ${source.lineno}, column ${source.colno || 1})` : '');
    errors.push(message);
    post({ type: 'error', message });
  }
  addEventListener('error', (e) => report(e.error || e.message, e));
  // Escape inside the app leaves Postbox’s full screen, unless the app used it (to close its own menu, say). The
  // app’s own listeners run after this one, so look once the key press has gone everywhere.
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape')
      setTimeout(() => {
        if (!e.defaultPrevented) post({ type: 'escape' });
      }, 0);
  });
  addEventListener('unhandledrejection', (e) => report(e.reason));

  // Size: Postbox sizes the frame to the content, up to its cap.
  let lastH = 0;
  const sizeNow = () => {
    const h = Math.ceil(document.documentElement.scrollHeight);
    if (h !== lastH) {
      lastH = h;
      post({ type: 'size', height: h });
    }
  };
  addEventListener('load', sizeNow);
  if (window.ResizeObserver) new ResizeObserver(sizeNow).observe(document.documentElement);

  // Review mode: registered anchors get a dashed amber outline and a name tag; clicking one pins a comment.
  function paintAnchors() {
    document.querySelectorAll('.pb-anchor-tag').forEach((t) => {
      t.remove();
    });
    for (const [name, el] of Object.entries(anchorMap)) {
      if (!el?.isConnected) continue;
      el.classList.toggle('anchor', reviewing);
      if (reviewing) {
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        const tag = document.createElement('button');
        tag.type = 'button';
        tag.className = 'anchor-tag pb-anchor-tag';
        tag.textContent = name;
        tag.setAttribute('aria-label', `Comment on ${name}`);
        tag.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          post({ type: 'pin', anchor: name });
        });
        el.appendChild(tag);
      }
    }
  }

  // Bundled libraries come from Postbox over the bridge and run as inline scripts. A sandboxed page can’t load
  // files in every browser (the Claude desktop app’s browser pane blocks them), and this way it never has to.
  const libs = {};
  function loadLib(name) {
    if (window[name]) return Promise.resolve(window[name]);
    libs[name] ??= call('lib', { name }).then(({ js, css }) => {
      if (css) {
        const st = document.createElement('style');
        st.textContent = css;
        document.head.appendChild(st);
      }
      const s = document.createElement('script');
      s.textContent = js;
      document.head.appendChild(s);
      if (!window[name]) throw new Error(`The ${name} library didn’t load.`);
      return window[name];
    });
    return libs[name];
  }
  const LIBS = { d3: () => loadLib('d3'), katex: () => loadLib('katex'), mermaid: () => loadLib('mermaid') };

  window.postbox = {
    ready,
    get check() {
      return !!init.check;
    },
    query: (tool, args) => call('query', { tool, args: args || {} }),
    // A data file the agent attached to this version (#54), as text.
    file: (name) => call('file', { name: String(name) }),
    send(action, values, summary) {
      if (init.check) return Promise.resolve({ ok: true, skipped: true });
      const v = Object.assign({}, values || {});
      if (summary) v.summary = summary;
      // Too large for one event: say so inside the app, before anything is posted, rather than lose it (#50).
      const max = init.limits?.eventBytes;
      let size = 0;
      try {
        size = JSON.stringify(v).length;
      } catch {
        // Not plain JSON: Postbox refuses it, and says so.
      }
      if (max && size > max) {
        const kb = (n) => `${Math.ceil(n / 1024).toLocaleString('en-US')} KB`;
        return Promise.reject(
          new Error(
            `postbox.send: these values are ${kb(size)} as JSON, larger than the ${kb(max)} one event can carry, so nothing was sent. Send ids instead, and look the items up from them.`,
          ),
        );
      }
      return call('event', { action, values: v });
    },
    saveState(state) {
      if (!init.check) post({ type: 'state', state });
    },
    restoreState: () => ready.then((r) => r.state),
    anchors(map) {
      anchorMap = Object.assign({}, map);
      post({ type: 'anchors', names: Object.keys(anchorMap).filter((k) => anchorMap[k]) });
      if (reviewing) paintAnchors();
    },
    on(event, fn) {
      (listeners[event] = listeners[event] || []).push(fn);
    },
    load(name) {
      if (!LIBS[name]) return Promise.reject(new Error(`There’s no bundled library called “${name}”.`));
      return LIBS[name]();
    },
    charts: null,
  };

  post({ type: 'hello' });

  // The pre-display check is app/kit/check.js, which Postbox adds to a check frame’s page after the kit.
  if (init.check) window.__pbCheck = { ready, errors, post, rgb, lum };
  // What the kit’s other scripts (app/kit/charts.js) share with it.
  window.__pbKit = { sizeNow, listeners, rgb, lum };

  function rgb(s) {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  }
  function lum(c) {
    const l = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * l(c.r) + 0.7152 * l(c.g) + 0.0722 * l(c.b);
  }

  // ── Narration ─────────────────────────────────────────────────────────────────────────
  // Needs the narrate.speak permission (and its agent needs the tool). Audio is made on the host by a local
  // Kokoro voice, one passage at a time, and only when you press Play, so the pre-display check makes none.
  const clipCache = new Map();
  async function narrate(text, opts = {}) {
    const key = `${opts.voice || ''}|${opts.speed || 1}|${text}`;
    if (!clipCache.has(key)) {
      clipCache.set(
        key,
        call('query', { tool: 'narrate.speak', args: { text, voice: opts.voice, speed: opts.speed } }).then((r) => {
          const bytes = Uint8Array.from(atob(r.wav), (c) => c.charCodeAt(0));
          return { url: URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })), ms: r.ms };
        }),
      );
      clipCache.get(key).catch(() => clipCache.delete(key));
    }
    return clipCache.get(key);
  }
  narrStyle();
  function narrStyle() {
    const st = document.createElement('style');
    st.textContent = `.pb-narr{display:flex;flex-direction:column;gap:10px}.pb-narr-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .pb-narr-status{font-size:12px;color:var(--dim)}.pb-narr ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
      .pb-narr li button{all:unset;box-sizing:border-box;display:block;width:100%;padding:6px 10px;border-radius:6px;border-left:3px solid transparent;color:var(--dim);cursor:pointer;line-height:1.45}
      .pb-narr li button:hover{background:var(--chip)}.pb-narr li button:focus-visible{outline:2px solid var(--focus,var(--accent));outline-offset:1px}
      .pb-narr li button[aria-current="true"]{color:var(--text);background:var(--sunk);border-left-color:var(--accent)}`;
    document.head.appendChild(st);
  }
  function narration(el, passages, opts = {}) {
    const list = (passages || []).map((p, i) =>
      typeof p === 'string' ? { id: `p${i + 1}`, text: p } : { id: p.id || `p${i + 1}`, text: String(p.text || '') },
    );
    const make = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const root = make('div', 'pb-narr');
    const bar = make('div', 'pb-narr-bar');
    const btn = make('button', 'btn', 'Play');
    btn.type = 'button';
    const status = make('span', 'pb-narr-status', `${list.length} passage${list.length === 1 ? '' : 's'} · read aloud by a local voice`);
    status.setAttribute('role', 'status');
    bar.append(btn, status);
    const ol = make('ol');
    ol.setAttribute('aria-label', opts.label || 'Transcript');
    const items = list.map((p, i) => {
      const li = make('li');
      const b = make('button', null, p.text);
      b.type = 'button';
      b.addEventListener('click', () => play(i));
      li.append(b);
      ol.append(li);
      return b;
    });
    root.append(bar, ol);
    el.replaceChildren(root);
    sizeNow();
    const audio = new Audio();
    let at = -1;
    let playing = false;
    const mark = (i) => {
      items.forEach((b, j) => {
        if (j === i) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      });
      opts.onPassage?.(i, list[i]);
    };
    async function play(i = Math.max(at, 0)) {
      if (i >= list.length) return stop(true);
      at = i;
      playing = true;
      btn.textContent = 'Pause';
      mark(i);
      status.textContent = `Preparing passage ${i + 1} of ${list.length}…`;
      try {
        const clip = await narrate(list[i].text, opts);
        if (!playing || at !== i) return;
        audio.src = clip.url;
        await audio.play();
        status.textContent = `Reading passage ${i + 1} of ${list.length}`;
        if (i + 1 < list.length) narrate(list[i + 1].text, opts).catch(() => {});
      } catch (e) {
        playing = false;
        btn.textContent = 'Play';
        status.textContent = `The voice isn’t available: ${e.message || e}. The transcript is all here.`;
      }
    }
    function stop(finished) {
      playing = false;
      audio.pause();
      btn.textContent = finished ? 'Play again' : 'Play';
      status.textContent = finished ? 'Finished.' : `Paused at passage ${at + 1} of ${list.length}`;
      if (finished) at = -1;
    }
    audio.addEventListener('ended', () => play(at + 1));
    btn.addEventListener('click', () => (playing ? stop(false) : play()));
    return {
      play,
      pause: () => stop(false),
      get index() {
        return at;
      },
    };
  }
  window.postbox.narrate = narrate;
  window.postbox.narration = narration;
})();
