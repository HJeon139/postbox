// Inlined after app/kit/graph-layout.js in every app sandbox page: postbox.graph(el, spec) (#888).
// Lays out a directed network with d3-force, groups nodes into soft cluster regions, keeps 12 px non-overlapping
// labels, draws directed arrows and cycle loops, scrolls sideways in narrow windows, and includes a Table view.

{
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const st = document.createElement('style');
  st.textContent = `.pb-graph{position:relative}.pb-graph-top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px}
    .pb-graph-scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
    .pb-graph-scroll:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .pb-graph svg{display:block}.pb-graph svg text{font:12px system-ui,sans-serif;font-variant-numeric:tabular-nums}
    .pb-graph-label{fill:var(--text);paint-order:stroke;stroke:var(--bg);stroke-width:3px;stroke-linejoin:round}
    .pb-graph-group-label{font-weight:600;fill:var(--text)}.pb-graph-tables{display:grid;gap:14px;overflow:auto;max-height:420px}`;
  document.head.appendChild(st);

  const elOf = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const svgEl = (tag, attrs = {}, text = null) => {
    const n = document.createElementNS(SVG_NS, tag);
    // lint-allow dom: attribute names come only from graph.js’s own literal objects, never from spec keys.
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
    if (text != null) n.textContent = text;
    return n;
  };

  /** Builds SVG <defs> with directed arrow markers for normal, highlighted, and cycle edges. */
  const defs = (uid) => {
    const d = svgEl('defs');
    const makeMarker = (id, fill) => {
      const m = svgEl('marker', { id, viewBox: '0 -4 8 8', refX: 8, refY: 0, markerWidth: 7, markerHeight: 7, orient: 'auto' });
      m.append(svgEl('path', { d: 'M0,-3.5L8,0L0,3.5Z', fill }));
      return m;
    };
    d.append(makeMarker(`${uid}-arr`, 'var(--dim)'), makeMarker(`${uid}-hi`, 'var(--text)'), makeMarker(`${uid}-cyc`, 'var(--alert)'));
    return d;
  };

  /** Computes a directed SVG path between two nodes: a loop for self-edges, curved arcs for cycles/pairs. */
  const edgePath = (e, pairSet) => {
    const s = e.source;
    const t = e.target;
    if (s.id === t.id) {
      const r = s.r + 22;
      return `M${s.x + s.r * 0.7},${s.y - s.r * 0.7} C${s.x + r},${s.y - r * 1.4} ${s.x - r},${s.y - r * 1.4} ${s.x - s.r * 0.7},${s.y - s.r * 0.7}`;
    }
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const sx = s.x + ux * (s.r + 2);
    const sy = s.y + uy * (s.r + 2);
    const tx = t.x - ux * (t.r + 4);
    const ty = t.y - uy * (t.r + 4);
    const hasReverse = pairSet.has(`${t.id}->${s.id}`);
    const bend = hasReverse ? 24 : e.inCycle ? 20 : e.sameGroup ? 8 : 16;
    const mx = (sx + tx) / 2 - uy * bend;
    const my = (sy + ty) / 2 + ux * bend;
    return `M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)}`;
  };

  /** Builds the SVG network drawing from a laid-out state. */
  const drawSvg = (state, regions, labels, uid) => {
    const svg = svgEl('svg', {
      width: state.width,
      height: state.height,
      viewBox: `0 0 ${state.width} ${state.height}`,
      role: 'img',
      'aria-label': state.label,
      style: `min-width:${state.width}px`,
    });
    svg.append(defs(uid));

    const regionG = svgEl('g', { class: 'pb-graph-groups' });
    for (const r of regions) {
      regionG.append(
        svgEl('path', {
          d: r.d,
          fill: `var(--${r.group.color})`,
          'fill-opacity': '0.09',
          stroke: `var(--${r.group.color})`,
          'stroke-opacity': '0.45',
          'stroke-width': '1.5',
          'stroke-dasharray': '5 4',
        }),
        svgEl('text', { x: r.lx.toFixed(1), y: r.ly.toFixed(1), class: 'pb-graph-group-label' }, r.group.label),
      );
    }
    svg.append(regionG);

    const pairSet = new Set(state.edges.map((e) => `${e.source.id}->${e.target.id}`));
    const edgeG = svgEl('g', { class: 'pb-graph-edges' });
    for (const e of state.edges) {
      const cycleHi = e.inCycle && e.highlight;
      const stroke = cycleHi ? 'var(--alert)' : e.highlight ? 'var(--text)' : 'var(--dim)';
      const marker = cycleHi ? `${uid}-cyc` : e.highlight ? `${uid}-hi` : `${uid}-arr`;
      edgeG.append(
        svgEl('path', {
          d: edgePath(e, pairSet),
          fill: 'none',
          stroke,
          'stroke-opacity': e.highlight ? '0.95' : '0.55',
          'stroke-width': e.highlight ? '2.2' : '1.3',
          'marker-end': `url(#${marker})`,
          'data-edge': `${e.from}->${e.to}`,
          ...(e.highlight ? { 'data-highlight': '1' } : {}),
        }),
      );
    }
    svg.append(edgeG);

    const nodeG = svgEl('g', { class: 'pb-graph-nodes' });
    for (const n of state.nodes) {
      const c = svgEl('circle', {
        cx: n.x.toFixed(1),
        cy: n.y.toFixed(1),
        r: n.r,
        fill: `var(--${n.color})`,
        stroke: 'var(--bg)',
        'stroke-width': '2',
        'data-node': n.id,
      });
      c.append(svgEl('title', {}, `${n.label}${n.group ? ` (${n.group})` : ''}${n.value != null ? ` · ${n.value}` : ''}`));
      nodeG.append(c);
    }
    svg.append(nodeG);

    const labelG = svgEl('g', { class: 'pb-graph-labels' });
    for (const l of labels) {
      labelG.append(
        svgEl(
          'text',
          { x: l.x.toFixed(1), y: l.y.toFixed(1), 'text-anchor': 'middle', class: 'pb-graph-label', 'data-node-label': l.node.id },
          l.node.label,
        ),
      );
    }
    svg.append(labelG);
    return svg;
  };

  /** Builds accessible HTML tables for every node and edge so every value is also available as text. */
  const buildTables = (state) => {
    const wrap = elOf('div', 'pb-graph-tables');
    const makeTable = (caption, headers, rows) => {
      const tbl = elOf('table', 'tbl');
      tbl.append(elOf('caption', 'small dim', caption));
      const thead = elOf('thead');
      const hr = elOf('tr');
      for (const h0 of headers) hr.append(elOf('th', null, h0));
      thead.append(hr);
      const tbody = elOf('tbody');
      for (const r of rows) {
        const tr = elOf('tr');
        for (const cell of r) tr.append(elOf('td', null, cell));
        tbody.append(tr);
      }
      tbl.append(thead, tbody);
      return tbl;
    };
    const outMap = new Map(state.nodes.map((n) => [n.id, []]));
    for (const e of state.edges) outMap.get(e.from)?.push(e.to);
    wrap.append(
      makeTable(
        'Nodes',
        ['Node', 'Group', 'Value', 'Links to'],
        state.nodes.map((n) => [n.label, n.group || '—', n.value != null ? String(n.value) : '—', (outMap.get(n.id) || []).join(', ') || '—']),
      ),
      makeTable(
        'Edges',
        ['From', 'To', 'Label', 'Highlighted'],
        state.edges.map((e) => [state.byId.get(e.from)?.label || e.from, state.byId.get(e.to)?.label || e.to, e.label || '—', e.highlight ? 'Yes' : 'No']),
      ),
    );
    return wrap;
  };

  /** Measures each node label’s real rendered box in SVG so wide and non-Latin glyphs never overlap. */
  const measureLabels = (nodes) => {
    const svg = svgEl('svg', {
      style: 'position:fixed;left:-9999px;top:-9999px;visibility:hidden;pointer-events:none;font:12px system-ui,sans-serif',
    });
    const texts = nodes.map((n) => {
      const t = svgEl('text', { class: 'pb-graph-label' }, n.label);
      svg.append(t);
      return [n, t];
    });
    document.body.append(svg);
    for (const [n, t] of texts) {
      const b = t.getBBox();
      n.labelW = Math.max(24, Math.ceil(b.width) + 6);
      n.labelH = Math.max(16, Math.ceil(b.height) + 4);
    }
    svg.remove();
  };

  let seq = 0;

  /**
   * Lays out and draws a directed network graph with d3-force, group cluster regions, non-overlapping 12 px labels,
   * highlighted/cycle edges, horizontal scrolling in narrow windows, and a Graph/Table toggle (#888).
   */
  window.postbox.graph = async (el, spec) => {
    const layout = window.__pbGraphLayout;
    const d3 = window.d3 || (await window.postbox.load('d3'));
    const state = layout.normalizeSpec(spec);
    layout.markHighlights(state, spec?.highlight);
    measureLabels(state.nodes);
    layout.runForceLayout(d3, state);
    const labels = layout.placeLabels(state.nodes, state.width, state.height);
    state.height = Math.max(state.height, labels.height || state.height);
    const regions = layout.groupRegions(d3, state.groups, state.nodes);
    const uid = `pbg-${++seq}`;

    el.classList.add('pb-graph');
    const top = elOf('div', 'pb-graph-top');
    const leg = elOf('div', 'pb-legend');
    for (const g of state.groups) {
      const item = elOf('span');
      const dot = elOf('i', 'dk');
      dot.style.background = `var(--${g.color})`;
      item.append(dot, document.createTextNode(g.label));
      leg.append(item);
    }
    const seg = elOf('span', 'seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', `${state.label} view`);
    const bGraph = elOf('button', null, 'Graph');
    const bTable = elOf('button', null, 'Table');
    bGraph.type = 'button';
    bTable.type = 'button';
    bGraph.setAttribute('role', 'radio');
    bTable.setAttribute('role', 'radio');
    bGraph.setAttribute('aria-checked', 'true');
    bTable.setAttribute('aria-checked', 'false');
    seg.append(bGraph, bTable);
    top.append(leg, seg);

    const scroll = elOf('div', 'pb-graph-scroll');
    scroll.append(drawSvg(state, regions, labels, uid));
    const tables = buildTables(state);
    tables.hidden = true;

    const syncScrollTab = () => {
      if (scroll.scrollWidth > scroll.clientWidth + 1) {
        scroll.tabIndex = 0;
        scroll.setAttribute('role', 'region');
        scroll.setAttribute('aria-label', `${state.label} (scroll sideways)`);
      } else {
        scroll.removeAttribute('tabindex');
        scroll.removeAttribute('role');
        scroll.removeAttribute('aria-label');
      }
    };

    const show = (which) => {
      bGraph.setAttribute('aria-checked', String(which === 'graph'));
      bTable.setAttribute('aria-checked', String(which === 'table'));
      scroll.hidden = which !== 'graph';
      tables.hidden = which !== 'table';
      if (which === 'graph') syncScrollTab();
    };
    bGraph.addEventListener('click', () => show('graph'));
    bTable.addEventListener('click', () => show('table'));

    el.replaceChildren(top, scroll, tables);
    syncScrollTab();
    if (typeof ResizeObserver === 'function') new ResizeObserver(syncScrollTab).observe(scroll);
    return { nodes: state.nodes, edges: state.edges, groups: state.groups };
  };
}
