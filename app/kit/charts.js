// The kit’s charts, preloaded after app/kit/kit.js in every agent-app sandbox: postbox.charts.line / scatter /
// stacked / heatmap / table. kit.js lists what they draw and which colors they use.
// A block, not a function, keeps its names out of the app’s global scope: Biome counts an IIFE as one long function.
{
  const { sizeNow, listeners, rgb, lum } = window.__pbKit;

  // ── Charts ────────────────────────────────────────────────────────────────────────────
  // Built to the chart rules: 2px lines, ringed dots, 2px gaps between touching marks, hairline grids,
  // labels in text colors (never series colors), a legend for 2+ series, and a table view for every chart.
  const _NS = 'http://www.w3.org/2000/svg';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const fmt = (n) => {
    if (typeof n !== 'number') return esc(n);
    return Math.abs(n) >= 10000 ? Math.round(n / 1000) + 'K' : n.toLocaleString('en-US');
  };
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
  const inkOn = (varName) => {
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
  };
  const style = document.createElement('style');
  style.textContent = `.pb-chart{position:relative}.pb-chart svg{display:block;overflow:visible}.pb-chart svg text{font:11px system-ui,sans-serif;font-variant-numeric:tabular-nums}
    .pb-chart-bar{display:flex;justify-content:flex-end;margin-bottom:6px}.pb-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--dim);padding:0 0 8px}
    .pb-legend span{display:inline-flex;align-items:center;gap:6px}.pb-legend .lk{width:14px;height:2px;border-radius:2px}.pb-legend .dk{width:8px;height:8px;border-radius:50%}.pb-legend .rk{width:10px;height:10px;border-radius:2px}
    .pb-table{overflow:auto;max-height:320px}`;
  document.head.appendChild(style);

  const mount = (el, draw, tableRows, label) => {
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
  };

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
          // Column labels that wouldn’t fit side by side show every few columns; the table view and each cell’s title name all.
          const every = Math.max(1, Math.ceil((Math.max(...spec.cols.map((c) => String(c).length)) * 6.5 + 8) / cw));
          let s = spec.cols
            .map((c, j) => (j % every ? '' : `<text x="${m.l + j * cw + cw / 2}" y="10" fill="var(--dim)" text-anchor="middle">${esc(c)}</text>`))
            .join('');
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
  // app/kit/graph.js draws its network in the same frame, with the same Table view.
  Object.assign(window.__pbKit, { mount, esc });
}
