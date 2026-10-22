// The app kit, preloaded in every agent-app sandbox. It gives agent code:
//   postbox.ready                 → Promise<{ state, theme, appId }>, resolves once Postbox says hello
//   postbox.query(tool, args)     → Promise<result>; only tools the app and its agent were granted
//   postbox.send(action, values, summary)  sends one event to the agent; summary is the line you see. Only
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
//   postbox.charts.line / scatter / stacked / heatmap / table   charts that follow Workbench’s rules
//   postbox.narrate(text, { voice, speed })   → Promise<{ url, ms }>, a clip read aloud by Postbox’s local voice
//   postbox.narration(el, passages, { voice, speed, onPassage })   a player with a transcript that follows along
// It also reports size changes and script errors to Postbox, and runs the pre-display check.
(function () {
  const me = document.currentScript;
  const init = JSON.parse(me.dataset.init || '{}');
  const pending = new Map();
  const listeners = { theme: [] };
  const errors = [];
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

  function report(err) {
    const message = String(err?.message || err);
    errors.push(message);
    post({ type: 'error', message });
  }
  addEventListener('error', (e) => report(e.error || e.message));
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

  // ── The pre-display check ─────────────────────────────────────────────────────────────
  // Run inside hidden frames at 375 and 1280 px before you see the app. Problems go to the agent.
  if (init.check) {
    // Wait until the layout stops changing (charts and lists render after their data arrives).
    const quiet = () =>
      new Promise((resolve) => {
        let last = -1,
          still = 0;
        const t = setInterval(() => {
          const sig = document.documentElement.scrollWidth * 100000 + document.documentElement.scrollHeight;
          still = sig === last ? still + 1 : 0;
          last = sig;
          if (still >= 3) {
            clearInterval(t);
            resolve();
          }
        }, 200);
        setTimeout(() => {
          clearInterval(t);
          resolve();
        }, 6000);
      });
    ready
      .then(() => new Promise((r) => setTimeout(r, 600)))
      .then(quiet)
      .then(() => {
        const problems = [];
        const w = innerWidth;
        const sw = document.documentElement.scrollWidth;
        if (sw > w + 1) problems.push({ code: `overflow-${w}`, message: `At ${w} px wide the content is ${sw} px wide, so it scrolls sideways.` });
        const named = (el) =>
          el.getAttribute('aria-label') ||
          el.getAttribute('aria-labelledby') ||
          el.getAttribute('title') ||
          (el.textContent || '').trim() ||
          (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
          el.closest('label');
        document.querySelectorAll('input:not([type=hidden]), select, textarea').forEach((el) => {
          if (
            !(
              el.getAttribute('aria-label') ||
              el.getAttribute('aria-labelledby') ||
              (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
              el.closest('label') ||
              el.getAttribute('title')
            )
          ) {
            problems.push({ code: 'unlabeled-field', message: `A ${el.tagName.toLowerCase()} has no label.` });
          }
        });
        document.querySelectorAll('button, [role=button], [role=checkbox], [role=radio], a[href]').forEach((el) => {
          if (!named(el)) problems.push({ code: 'unlabeled-control', message: 'A button or link has no text or label.' });
        });
        document.querySelectorAll('img:not([alt])').forEach(() => {
          problems.push({ code: 'missing-alt', message: 'An image has no alt text.' });
        });
        document.querySelectorAll('[tabindex]').forEach((el) => {
          if (+el.getAttribute('tabindex') > 0)
            problems.push({ code: 'tab-order', message: 'An element sets a positive tabindex, which breaks keyboard order.' });
        });
        let low = 0;
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const seen = new Set();
        for (let n = walk.nextNode(); n && low < 3; n = walk.nextNode()) {
          const el = n.parentElement;
          if (!n.textContent.trim() || !el || seen.has(el) || el.closest('svg')) continue;
          seen.add(el);
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
          const fg = rgb(cs.color);
          const bg = background(el);
          if (!fg || !bg) continue;
          const ratio = contrast(blend(fg, bg), bg);
          const size = parseFloat(cs.fontSize);
          const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700);
          if (ratio < (large ? 3 : 4.5)) {
            low++;
            problems.push({
              code: 'contrast',
              message: `Text “${n.textContent.trim().slice(0, 30)}” has contrast ${ratio.toFixed(2)}:1; it needs ${large ? 3 : 4.5}:1.`,
            });
          }
        }
        problems.push(...legibility(w));
        for (const e of errors) problems.push({ code: 'script-error', message: e });
        post({ type: 'check', width: w, problems });
      });
  }
  // Legibility: SVG marks, labels and dash patterns too small to read at this width, and an app that shows only an
  // error. These are warnings: the app is still shown, and the agent is told.
  function legibility(w) {
    const out = [];
    const shown = (el) => {
      const b = el.getBoundingClientRect();
      if (!b.width && !b.height) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0;
    };
    // How much an SVG element is scaled on screen, from its user units.
    const scale = (el) => {
      const m = el.getScreenCTM?.();
      return m ? Math.hypot(m.a, m.b) : 1;
    };
    const px = (n) => Math.round(n * 10) / 10;
    let marks = 0;
    let tiny = 0;
    let dashed = 0;
    let finest = Infinity;
    for (const el of document.querySelectorAll('svg circle, svg rect, svg ellipse, svg path, svg line, svg polyline, svg polygon')) {
      if (el.closest('defs, clipPath, mask, marker, pattern, symbol') || !shown(el)) continue;
      const cs = getComputedStyle(el);
      const stroked = cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0;
      if (cs.fill === 'none' && !stroked) continue;
      const b = el.getBoundingClientRect();
      marks++;
      if (Math.max(b.width, b.height) < 4) tiny++;
      if (stroked && cs.strokeDasharray && cs.strokeDasharray !== 'none' && !cs.strokeDasharray.includes('%')) {
        const k = scale(el);
        const parts = cs.strokeDasharray
          .split(/[\s,]+/)
          .map(parseFloat)
          .filter((n) => n > 0);
        const dash = Math.min(...parts) * k;
        const width = parseFloat(cs.strokeWidth) * k;
        if (parts.length && (dash < 2 || width < 1)) {
          dashed++;
          finest = Math.min(finest, dash, width);
        }
      }
    }
    if (tiny >= 20 && tiny / marks >= 0.25)
      out.push({
        code: 'marks-too-small',
        message: `At ${w} px, ${tiny} of ${marks} marks are under 4 px across, too small to see or point at. Draw fewer, larger marks (group, sample or bin them), or let the person filter or zoom.`,
      });
    if (dashed)
      out.push({
        code: 'dashes-too-fine',
        message: `At ${w} px, ${dashed} dashed ${dashed === 1 ? 'line has' : 'lines have'} dashes, gaps or strokes of ${px(finest)} px, too fine to tell from a solid line. Use dashes of at least 4 px, gaps of 3 px and lines 1 px wide, or tell the series apart by color and a label.`,
      });
    // Text: SVG labels at their scaled size, and page text at its font size.
    const sizes = [];
    for (const el of document.querySelectorAll('svg text'))
      if (shown(el) && el.textContent.trim()) sizes.push(parseFloat(getComputedStyle(el).fontSize) * scale(el));
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    const words = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || el.closest('svg') || !shown(el)) continue;
      words.push(n.textContent);
      if (seen.has(el)) continue;
      seen.add(el);
      sizes.push(parseFloat(getComputedStyle(el).fontSize));
    }
    const small = sizes.filter((s) => s < 9);
    if (small.length >= 3 && small.length / sizes.length >= 0.2)
      out.push({
        code: 'text-too-small',
        message: `At ${w} px, ${small.length} of ${sizes.length} labels are drawn under 9 px (the smallest at ${px(Math.min(...small))} px), too small to read. Make them larger, or show fewer.`,
      });
    // An app that shows only an error or a missing-data message hasn’t worked, even if nothing else is wrong.
    const said = words.join(' ').trim().replace(/\s+/g, ' ');
    const content = marks || document.querySelector('canvas, table tr, input, select, textarea, img');
    if (said && said.length < 300 && !content && ONLY_ERROR.test(said))
      out.push({
        code: 'only-error',
        message: `It shows only “${said.slice(0, 120)}”, which reads as an error or missing data. Make sure the data it needs is there, or say what the person can do.`,
      });
    return out;
  }
  const ONLY_ERROR = /\b(?:error|failed|isn[’']t loaded|not loaded|restart postbox|no data|missing|couldn[’']t|could not|can[’']t load|unable to|not found)\b/i;
  function rgb(s) {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  }
  function background(el) {
    for (let e = el; e; e = e.parentElement) {
      const c = rgb(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0.95) return c;
    }
    return rgb(getComputedStyle(document.documentElement).backgroundColor) || { r: 0, g: 0, b: 0, a: 1 };
  }
  function blend(f, b) {
    return { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 };
  }
  function lum(c) {
    const l = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * l(c.r) + 0.7152 * l(c.g) + 0.0722 * l(c.b);
  }
  function contrast(a, b) {
    const x = lum(a),
      y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  // ── Charts ────────────────────────────────────────────────────────────────────────────
  // Built to the chart rules: 2px lines, ringed dots, 2px gaps between touching marks, hairline grids,
  // labels in text colors (never series colors), a legend for 2+ series, and a table view for every chart.
  const _NS = 'http://www.w3.org/2000/svg';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const fmt = (n) => (typeof n === 'number' ? (Math.abs(n) >= 10000 ? Math.round(n / 1000) + 'K' : n.toLocaleString('en-US')) : esc(n));
  const scale = (d0, d1, r0, r1) => (x) => r0 + ((x - d0) / (d1 - d0 || 1)) * (r1 - r0);
  const ring = (x, y, color, r) => `<circle cx="${x}" cy="${y}" r="${r || 4}" fill="var(--${color})" stroke="var(--panel)" stroke-width="2"/>`;
  const legend = (items, key) =>
    items.length < 2
      ? ''
      : `<div class="pb-legend">${items.map(([n, c]) => `<span><i class="${key}" style="background:var(--${c})"></i>${esc(n)}</span>`).join('')}</div>`;
  const path = (pts) => 'M' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L');
  const svg = (w, h, inner, label) => `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${inner}</svg>`;
  const gridY = (ticks, y, x0, x1, f) =>
    ticks
      .map(
        (t) =>
          `<line x1="${x0}" x2="${x1}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/><text x="${x0 - 6}" y="${y(t)}" fill="var(--dim)" text-anchor="end" dominant-baseline="middle">${f(t)}</text>`,
      )
      .join('');
  const niceTicks = (max, n) => {
    const step = 10 ** Math.floor(Math.log10(max / n));
    const s = [1, 2, 2.5, 5, 10].map((k) => k * step).find((k) => max / k <= n) || step * 10;
    const out = [];
    for (let v = 0; v <= max + 1e-9; v += s) out.push(+v.toFixed(10));
    return out;
  };
  // Black or white text on a token color, whichever contrasts more. It parses the token and returns fixed inks.
  function inkOn(varName) {
    const c = rgb(
      getComputedStyle(document.documentElement)
        .getPropertyValue(varName)
        .trim()
        // lint-allow tokens: converts the token’s value for measuring.
        .replace(/^#(..)(..)(..)$/, (_m, r, g, b) => `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`),
    );
    if (!c) return '#ffffff'; // lint-allow tokens: pure white and near-black are the two inks this picks between.
    const L = lum(c);
    // lint-allow tokens: as above.
    return (L + 0.05) / 0.0534 >= 1.05 / (L + 0.05) ? '#0b0b0b' : '#ffffff';
  }
  const style = document.createElement('style');
  style.textContent = `.pb-chart{position:relative}.pb-chart svg{display:block;overflow:visible}.pb-chart svg text{font:11px system-ui,sans-serif;font-variant-numeric:tabular-nums}
    .pb-chart-bar{display:flex;justify-content:flex-end;margin-bottom:6px}.pb-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--dim);padding:0 0 8px}
    .pb-legend span{display:inline-flex;align-items:center;gap:6px}.pb-legend .lk{width:14px;height:2px;border-radius:2px}.pb-legend .dk{width:8px;height:8px;border-radius:50%}.pb-legend .rk{width:10px;height:10px;border-radius:2px}
    .pb-table{overflow:auto;max-height:320px}`;
  document.head.appendChild(style);

  function mount(el, draw, tableRows, label) {
    el.classList.add('pb-chart');
    // lint-allow dom: the kit’s own template; every value goes through esc() or fmt().
    el.innerHTML = `<div class="pb-chart-bar"><span class="seg" role="radiogroup" aria-label="${esc(label)} view"><button role="radio" aria-checked="true" data-v="chart">Chart</button><button role="radio" aria-checked="false" data-v="table">Table</button></span></div><div class="pb-plot"></div><div class="pb-table" hidden></div>`;
    const plot = el.querySelector('.pb-plot');
    const table = el.querySelector('.pb-table');
    // lint-allow dom: as above.
    table.innerHTML = `<table class="tbl"><thead><tr>${tableRows[0].map((c) => `<th style="padding:8px 12px">${esc(c)}</th>`).join('')}</tr></thead><tbody>${tableRows
      .slice(1)
      .map((r) => `<tr>${r.map((c) => `<td>${fmt(c)}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`;
    el.querySelector('.seg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      el.querySelectorAll('.seg button').forEach((x) => {
        x.setAttribute('aria-checked', String(x === b));
      });
      plot.hidden = b.dataset.v === 'table';
      table.hidden = b.dataset.v !== 'table';
      sizeNow();
    });
    // Before layout, a chart has no width yet; draw it narrow rather than overflow the screen.
    const render = () => {
      // lint-allow dom: the chart drawers build SVG from numbers and esc()’d labels.
      plot.innerHTML = draw(Math.max(240, plot.clientWidth || el.clientWidth || Math.min(innerWidth - 40, 320)));
      sizeNow();
    };
    render();
    if (window.ResizeObserver) {
      let last = 0;
      new ResizeObserver(() => {
        const w = plot.clientWidth;
        if (w && Math.abs(w - last) > 4) {
          last = w;
          render();
        }
      }).observe(plot);
    }
    listeners.theme.push(render);
  }

  const charts = {
    line(el, spec) {
      const xs = spec.x;
      const series = spec.series.map((s, i) => Object.assign({ color: 's' + (i + 1) }, s));
      const max = spec.yMax || Math.max(...series.flatMap((s) => s.values)) * 1.1;
      const f = spec.yFormat || fmt;
      mount(
        el,
        (w) => {
          const narrow = w < 420;
          const m = { l: 40, r: narrow || series.length > 4 ? 14 : 96, t: 8, b: 24 },
            h = spec.height || 220;
          const x = scale(0, xs.length - 1, m.l, w - m.r),
            y = scale(0, max, h - m.b, m.t);
          let s = gridY(niceTicks(max, 4), y, m.l, w - m.r, f);
          xs.forEach((v, i) => {
            if (i % Math.ceil(xs.length / 5) === 0 || i === xs.length - 1)
              s += `<text x="${x(i)}" y="${h - 6}" fill="var(--dim)" text-anchor="middle">${esc(v)}</text>`;
          });
          for (const sr of series) {
            s += `<path d="${path(sr.values.map((v, i) => [x(i), y(v)]))}" fill="none" stroke="var(--${sr.color})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
            const last = sr.values[sr.values.length - 1];
            s += ring(x(xs.length - 1), y(last), sr.color);
            if (m.r > 20)
              s += `<text x="${x(xs.length - 1) + 8}" y="${y(last)}" dominant-baseline="middle" fill="var(--text)">${esc(sr.name)} <tspan fill="var(--dim)">${f(last)}</tspan></text>`;
          }
          return (
            legend(
              series.map((sr) => [sr.name, sr.color]),
              'lk',
            ) + svg(w, h, s, spec.label || 'Line chart')
          );
        },
        [['', ...series.map((s) => s.name)], ...xs.map((v, i) => [v, ...series.map((s) => s.values[i])])],
        spec.label || 'Line chart',
      );
    },
    scatter(el, spec) {
      const groups = spec.groups.slice(0, 3).map((g, i) => Object.assign({ color: 's' + (i + 1) }, g));
      mount(
        el,
        (w) => {
          const m = { l: 34, r: 12, t: 8, b: 34 },
            h = spec.height || 240;
          const x = scale(0, spec.xMax, m.l, w - m.r),
            y = scale(0, spec.yMax, h - m.b, m.t);
          let s = gridY(niceTicks(spec.yMax, 4), y, m.l, w - m.r, (t) => +t.toFixed(2));
          niceTicks(spec.xMax, 5).forEach((t) => {
            s += `<text x="${x(t)}" y="${h - 18}" fill="var(--dim)" text-anchor="middle">${t}</text>`;
          });
          s += `<text x="${(m.l + w - m.r) / 2}" y="${h - 2}" fill="var(--dim)" text-anchor="middle">${esc(spec.x || '')} →</text>`;
          for (const g of groups) for (const p of g.points) s += ring(x(p[0]), y(p[1]), g.color);
          return (
            legend(
              groups.map((g) => [g.name, g.color]),
              'dk',
            ) + svg(w, h, s, spec.label || 'Scatter plot')
          );
        },
        [['Group', spec.x || 'x', spec.y || 'y'], ...groups.flatMap((g) => g.points.map((p) => [g.name, +p[0].toFixed(2), +p[1].toFixed(2)]))],
        spec.label || 'Scatter plot',
      );
    },
    stacked(el, spec) {
      const series = spec.series.map((s, i) => Object.assign({ color: 's' + (i + 1) }, s));
      const cats = spec.categories;
      const totals = cats.map((_, i) => series.reduce((a, s) => a + s.values[i], 0));
      const max = spec.percent === false ? Math.max(...totals) : 100;
      mount(
        el,
        (w) => {
          const m = { l: 100, r: 48, t: 4, b: 22 },
            row = 34,
            bar = 20,
            h = m.t + cats.length * row + m.b;
          const x = scale(0, max, m.l, w - m.r);
          let s = niceTicks(max, 3)
            .map(
              (t) =>
                `<line x1="${x(t)}" x2="${x(t)}" y1="${m.t}" y2="${h - m.b}" stroke="var(--line)"/><text x="${x(t)}" y="${h - 6}" fill="var(--dim)" text-anchor="middle">${fmt(t)}${spec.percent === false ? '' : '%'}</text>`,
            )
            .join('');
          cats.forEach((c, i) => {
            const y0 = m.t + i * row + (row - bar) / 2;
            s += `<text x="${m.l - 8}" y="${y0 + bar / 2}" fill="var(--text)" text-anchor="end" dominant-baseline="middle">${esc(c)}</text>`;
            let acc = 0;
            series.forEach((sr, k) => {
              const v = spec.percent === false ? sr.values[i] : (sr.values[i] / totals[i]) * 100;
              const last = k === series.length - 1;
              const x0 = x(acc) + (k ? 1 : 0),
                x1 = x(acc + v) - (last ? 0 : 1),
                wd = Math.max(0, x1 - x0),
                r = last ? Math.min(4, wd / 2) : 0;
              s += r
                ? `<path d="M${x0},${y0}H${x1 - r}Q${x1},${y0} ${x1},${y0 + r}V${y0 + bar - r}Q${x1},${y0 + bar} ${x1 - r},${y0 + bar}H${x0}Z" fill="var(--${sr.color})"/>`
                : `<rect x="${x0}" y="${y0}" width="${wd}" height="${bar}" fill="var(--${sr.color})"/>`;
              const label = spec.percent === false ? fmt(sr.values[i]) : Math.round(v) + '%';
              if (series.length > 1 && wd >= label.length * 7 + 12)
                s += `<text x="${x0 + wd / 2}" y="${y0 + bar / 2}" text-anchor="middle" dominant-baseline="central" fill="${inkOn('--' + sr.color)}" font-weight="600">${label}</text>`;
              acc += v;
            });
            if (series.length === 1) s += `<text x="${x(acc) + 6}" y="${y0 + bar / 2}" dominant-baseline="middle" fill="var(--text)">${fmt(totals[i])}</text>`;
          });
          return (
            legend(
              series.map((sr) => [sr.name, sr.color]),
              'rk',
            ) + svg(w, h, s, spec.label || 'Bar chart')
          );
        },
        [['', ...series.map((s) => s.name)], ...cats.map((c, i) => [c, ...series.map((s) => s.values[i])])],
        spec.label || 'Bar chart',
      );
    },
    heatmap(el, spec) {
      const max = Math.max(...spec.values.flat());
      const step = (v) => Math.min(6, 1 + Math.floor((v / (max + 1)) * 6));
      mount(
        el,
        (w) => {
          const m = { l: 92, r: 4, t: 18, b: 4 },
            cw = (w - m.l - m.r) / spec.cols.length,
            ch = 26,
            h = m.t + spec.rows.length * ch + m.b;
          let s = spec.cols.map((c, j) => `<text x="${m.l + j * cw + cw / 2}" y="10" fill="var(--dim)" text-anchor="middle">${esc(c)}</text>`).join('');
          spec.rows.forEach((r, i) => {
            s += `<text x="${m.l - 8}" y="${m.t + i * ch + ch / 2}" fill="var(--text)" text-anchor="end" dominant-baseline="middle">${esc(r)}</text>`;
            spec.values[i].forEach((v, j) => {
              s += `<rect x="${m.l + j * cw + 1}" y="${m.t + i * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="var(--seq-${step(v)})"><title>${esc(r)} · ${esc(spec.cols[j])}: ${v}</title></rect>`;
            });
          });
          const lg = `<div class="pb-legend">${[1, 2, 3, 4, 5, 6].map((k) => `<span><i class="rk" style="background:var(--seq-${k})"></i>${Math.round(((k - 1) / 6) * max)}–${Math.round((k / 6) * max)}</span>`).join('')}</div>`;
          return lg + svg(w, h, s, spec.label || 'Heatmap');
        },
        [['', ...spec.cols], ...spec.rows.map((r, i) => [r, ...spec.values[i]])],
        spec.label || 'Heatmap',
      );
    },
    table(el, spec) {
      // lint-allow dom: the kit’s own template; every value goes through esc() or fmt().
      el.innerHTML = `<div class="pb-table" style="max-height:none"><table class="tbl"><thead><tr>${spec.columns.map((c) => `<th style="padding:8px 12px">${esc(c)}</th>`).join('')}</tr></thead><tbody>${spec.rows.map((r) => `<tr>${r.map((c) => `<td>${fmt(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      sizeNow();
    },
  };
  window.postbox.charts = charts;

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
