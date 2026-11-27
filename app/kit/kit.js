// The app kit, preloaded in every agent-app sandbox. It gives agent code:
//   postbox.ready                 → Promise<{ state, theme, appId }>, resolves once Postbox says hello
//   postbox.query(tool, args)     → Promise<result>; only tools the app and its agent were granted
//   postbox.file(name)            → Promise<string>; a data file the agent attached to this version (#54)
//   postbox.send(action, values, summary)  one event to the agent: app/kit/send.js, inlined after this
//   postbox.saveState(obj) / postbox.restoreState()   survives unload, reload and new versions
//   postbox.anchors({ name: element })   parts you can pin review comments to
//   postbox.on('theme', fn)       called when light/dark changes (tokens update by themselves)
//   postbox.load('d3' | 'katex' | 'mermaid')   loads a bundled library
//   postbox.charts.line / scatter / stacked / heatmap / table   charts that follow Workbench’s rules. Colors:
//                                 the chart palettes and the status-only colors, with when to use each, are
//                                 PALETTES in shared/limits.mjs, which the guide gives agents; these charts use
//                                 --s1…--s8 for series and --seq-* for heatmaps
//   postbox.narrate(text, { voice, speed })   → Promise<{ url, ms }>, a clip read aloud by Postbox’s local voice
//   postbox.narration(el, passages, { voice, speed, onPassage })   a player with a transcript that follows along
//                                 (both in app/kit/narration.js, inlined after this)
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
  // The parts a review hears the app names: the ones still set (#855). Both reports use it, so they agree.
  const namedParts = () => Object.keys(anchorMap).filter((k) => anchorMap[k]);
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
      // Each listener runs in a microtask of its own, so one that throws stops no other, and its error reaches the
      // window’s error handler below with the line it happened on (#819).
      for (const fn of listeners.theme) queueMicrotask(() => fn(m.theme));
    } else if (m.type === 'resize' && init.check) {
      // The check’s stand-in for the resizes a live frame gets in its first second (#819); the frame keeps its width.
      dispatchEvent(new Event('resize'));
    } else if (m.type === 'reply') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
    } else if (m.type === 'review') {
      reviewing = !!m.on;
      paintAnchors();
    } else if (m.type === 'probe') {
      probe(m);
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
    post({ type: 'error', message, drawn: !!window.__pbDrawn?.drawn() }); // an app that drew keeps running (#964)
  }
  addEventListener('error', (e) => window.__pbDrawn?.harmless(e) || report(e.error || e.message, e));
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

  // What’s under a region the person marked in a review, in px of the page (#856): the named parts it overlaps, and the
  // innermost element at its center. The page cuts and checks the answer (shared/review-regions.mjs, underOf).
  function probe(m) {
    const [x, y] = [m.x - scrollX, m.y - scrollY];
    const over = (r) => r.left <= x + m.w && x <= r.right && r.top <= y + m.h && y <= r.bottom;
    const parts = namedParts().filter((k) => anchorMap[k].isConnected && over(anchorMap[k].getBoundingClientRect()));
    const hit = document.elementFromPoint(x + m.w / 2, y + m.h / 2);
    const el = hit?.closest('.pb-anchor-tag')?.parentElement ?? hit;
    // Without the class the kit itself gives a part in review mode.
    const cls = el ? [...el.classList].filter((c) => c !== 'anchor').join(' ') : '';
    const element = el && { tag: el.tagName, id: el.id, class: cls, text: (el.textContent || '').slice(0, 400) };
    post({ type: 'probed', id: m.id, parts, element });
  }

  // In review mode a click anywhere in a highlighted part pins a comment on it, as the review’s hint says, not only a
  // click on its name tag. A click on one of the app’s own controls in the part still works the app. In nested parts,
  // the innermost takes it.
  const CONTROLS = 'a,button,input,select,textarea,label,summary,[tabindex],[contenteditable]';
  addEventListener('click', (e) => {
    if (!reviewing || e.defaultPrevented || !(e.target instanceof Element)) return;
    const hits = Object.entries(anchorMap).filter(([, el]) => el?.isConnected && el.contains(e.target));
    const inner = hits.find(([, el]) => !hits.some(([, other]) => other !== el && el.contains(other)));
    const control = e.target.closest(CONTROLS);
    // A part that takes focus itself, as a card may, isn’t a control inside it.
    if (!inner || (control && control !== inner[1] && inner[1].contains(control))) return;
    post({ type: 'pin', anchor: inner[0] });
  });

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
    saveState(state) {
      if (!init.check) post({ type: 'state', state });
    },
    restoreState: () => ready.then((r) => r.state),
    anchors(map) {
      // “the whole app” is a review’s comment on the app as a whole, so no part can take that name (#855), and “region 1”,
      // “region 2” and so on are the regions the person marks on it, so no part can take those either (#856).
      const { 'the whole app': _whole, ...named } = map || {};
      anchorMap = Object.fromEntries(Object.entries(named).filter(([name]) => !/^region [1-9]\d*$/.test(name)));
      post({ type: 'anchors', names: namedParts() });
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
  // Once the page’s own scripts have run, the parts it names, none included: a review says when there are none (#855).
  addEventListener('load', () => post({ type: 'anchors', names: namedParts() }));

  // The pre-display check is app/kit/check.js, which Postbox adds to a check frame’s page after the kit.
  if (init.check) window.__pbCheck = { ready, errors, post, rgb, lum };

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
  // Labels measured as the charts draw them: an SVG <text> in a .pb-chart, so it has their font and tabular figures (a
  // canvas can’t set those, and measured digits too narrow, so a date label was cut). The probe is in the page only
  // while it measures. A label wider than its room ends in “…” on a whole character, with its full name in a title;
  // the table view names every one in full.
  function fitLabels(labels, room) {
    const box = document.createElement('div');
    box.className = 'pb-chart';
    box.style.position = 'absolute';
    box.style.visibility = 'hidden';
    const probe = document.createElementNS(_NS, 'text');
    box.appendChild(document.createElementNS(_NS, 'svg')).appendChild(probe);
    document.body.appendChild(box);
    const width = (t) => {
      probe.textContent = t;
      return probe.getComputedTextLength();
    };
    const dots = width('…');
    const fitted = labels.map((label) => {
      const t = String(label);
      const full = width(t);
      if (full <= room) return { text: esc(t), w: full };
      // The longest run of whole characters that fits with its “…”, by a binary search over where each one ends.
      const ends = [];
      let at = 0;
      for (const c of graphemes(t)) ends.push((at += c.length));
      let lo = 0;
      let hi = ends.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (probe.getSubStringLength(0, ends[mid]) + dots <= room) lo = mid;
        else hi = mid - 1;
      }
      const cut = t.slice(0, ends[lo]) + '…';
      return { text: `${esc(cut)}<title>${esc(t)}</title>`, w: width(cut) };
    });
    box.remove();
    return fitted;
  }
  const graphemes = (t) => (window.Intl?.Segmenter ? [...new Intl.Segmenter().segment(t)].map((x) => x.segment) : Array.from(t));
  // Room for a chart’s category labels, drawn right-aligned left of its marks: the longest label’s width, up to half
  // the chart’s, so a long name (a note’s path) never runs off the page’s left edge, which an agent can’t fix in the kit.
  function labelRoom(labels, w) {
    const fitted = fitLabels(labels, Math.floor(w / 2) - 10);
    return { left: Math.ceil(Math.max(0, ...fitted.map((x) => x.w))) + 10, labels: fitted.map((x) => x.text) };
  }
  // A line chart’s end labels, each series’ name and last value right of its line: the room the widest takes, up to
  // 40% of the chart, where a longer name ends in “…” with its full name in a title.
  function endLabels(series, f, w) {
    const cap = Math.floor(w * 0.4);
    const values = fitLabels(
      series.map((sr) => f(sr.values[sr.values.length - 1])),
      cap,
    );
    const names = series.map((sr, k) => fitLabels([sr.name], cap - 16 - values[k].w)[0]);
    return { room: Math.ceil(Math.max(14, ...names.map((n, k) => 16 + n.w + values[k].w))), names: names.map((n) => n.text) };
  }
  // A line chart’s x labels, each measured whole and centered on its point, kept inside the chart. They’re a step apart,
  // about five at most, with the last always shown, and the step grows until no two are closer than 8 px. Only a label
  // that still has no room, beside its neighbors or the chart’s edge, is cut, with its full name in a title.
  function xLabels(xs, x, w, y0) {
    const n = xs.length;
    if (!n) return '';
    const full = fitLabels(xs, Infinity);
    const placed = (every) => {
      const at = [];
      for (let i = 0; i < n; i += every) at.push(i);
      if (at[at.length - 1] !== n - 1) at.push(n - 1);
      const centers = at.map((i) => Math.min(Math.max(x(i), full[i].w / 2 + 1), w - full[i].w / 2 - 1));
      // How far each label has to its neighbors, past their halves and 8 px apart.
      const free = at.map((_i, k) => {
        const left = k ? centers[k] - centers[k - 1] - full[at[k - 1]].w / 2 - 8 : Infinity;
        const right = k < at.length - 1 ? centers[k + 1] - centers[k] - full[at[k + 1]].w / 2 - 8 : Infinity;
        return Math.min(left, right, centers[k] - 1, w - 1 - centers[k]);
      });
      return { at, centers, free };
    };
    let every = Math.max(1, Math.ceil(n / 5));
    let layout = placed(every);
    while (every < n - 1 && layout.at.some((i, k) => layout.free[k] < full[i].w / 2)) layout = placed(++every);
    return layout.at
      .map((i, k) => {
        const room = 2 * layout.free[k];
        const label = full[i].w <= room ? full[i] : fitLabels([xs[i]], room)[0];
        return `<text x="${layout.centers[k]}" y="${y0}" fill="var(--dim)" text-anchor="middle">${label.text}</text>`;
      })
      .join('');
  }
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
  // Black or white text on a token color, whichever contrasts more. It parses the token and returns fixed inks. Pure
  // black, not a near-black: the better of black and white then reaches at least √21 ≈ 4.58:1 on any fill, over the
  // 4.5:1 the app check holds apps to (#997). With #0b0b0b, light --s1’s labels fell to 4.46:1 (#1014).
  function inkOn(varName) {
    const c = rgb(
      getComputedStyle(document.documentElement)
        .getPropertyValue(varName)
        .trim()
        // lint-allow tokens: converts the token’s value for measuring.
        .replace(/^#(..)(..)(..)$/, (_m, r, g, b) => `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`),
    );
    if (!c) return '#ffffff'; // lint-allow tokens: pure white and pure black are the two inks this picks between.
    const L = lum(c);
    // lint-allow tokens: as above.
    return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#000000' : '#ffffff';
  }
  const style = document.createElement('style');
  style.textContent = `.pb-chart{position:relative}.pb-chart svg{display:block;overflow:visible}.pb-chart svg text{font:12px system-ui,sans-serif;font-variant-numeric:tabular-nums}
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
          const ends = narrow || series.length > 4 ? null : endLabels(series, f, w);
          const m = { l: 40, r: ends ? ends.room : 14, t: 8, b: 24 },
            h = spec.height || 220;
          const x = scale(0, xs.length - 1, m.l, w - m.r),
            y = scale(0, max, h - m.b, m.t);
          let s = gridY(niceTicks(max, 4), y, m.l, w - m.r, f);
          s += xLabels(xs, x, w, h - 6);
          series.forEach((sr, k) => {
            s += `<path d="${path(sr.values.map((v, i) => [x(i), y(v)]))}" fill="none" stroke="var(--${sr.color})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
            const last = sr.values[sr.values.length - 1];
            s += ring(x(xs.length - 1), y(last), sr.color);
            if (ends)
              s += `<text x="${x(xs.length - 1) + 8}" y="${y(last)}" dominant-baseline="middle" fill="var(--text)">${ends.names[k]} <tspan fill="var(--dim)">${f(last)}</tspan></text>`;
          });
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
          const room = labelRoom(cats, w);
          const m = { l: room.left, r: 48, t: 4, b: 22 },
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
          cats.forEach((_c, i) => {
            const y0 = m.t + i * row + (row - bar) / 2;
            s += `<text x="${m.l - 8}" y="${y0 + bar / 2}" fill="var(--text)" text-anchor="end" dominant-baseline="middle">${room.labels[i]}</text>`;
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
          const room = labelRoom(spec.rows, w);
          const m = { l: room.left, r: 4, t: 18, b: 4 },
            cw = (w - m.l - m.r) / spec.cols.length,
            ch = 26,
            h = m.t + spec.rows.length * ch + m.b;
          // Column labels that wouldn’t fit side by side show every few columns; the table view and each cell’s title name all.
          const every = Math.max(1, Math.ceil((Math.max(...spec.cols.map((c) => String(c).length)) * 6.5 + 8) / cw));
          let s = spec.cols
            .map((c, j) => (j % every ? '' : `<text x="${m.l + j * cw + cw / 2}" y="10" fill="var(--dim)" text-anchor="middle">${esc(c)}</text>`))
            .join('');
          spec.rows.forEach((r, i) => {
            s += `<text x="${m.l - 8}" y="${m.t + i * ch + ch / 2}" fill="var(--text)" text-anchor="end" dominant-baseline="middle">${room.labels[i]}</text>`;
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
})();
