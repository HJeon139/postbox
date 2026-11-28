// Inlined after app/kit/graph-layout.js in every app sandbox page: postbox.graph(el, spec) (#888).
// Lays out a directed network with d3-force, groups nodes into soft cluster regions, keeps 12 px non-overlapping
// labels, draws directed arrows and cycle loops, scrolls sideways in narrow windows, and includes a Table view.

{
  const st = document.createElement('style');
  st.textContent = `.pb-graph{position:relative}.pb-graph-top{display:flex;justify-content:flex-end;margin-bottom:8px}
    .pb-graph > .pb-legend{margin-top:8px;overflow-wrap:anywhere}
    .pb-graph-scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
    .pb-graph-scroll:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .pb-graph svg{display:block}.pb-graph svg text{font:12px system-ui,sans-serif;font-variant-numeric:tabular-nums}
    .pb-graph-label{fill:var(--text);paint-order:stroke;stroke:var(--bg);stroke-width:3px;stroke-linejoin:round}
    .pb-graph svg .pb-graph-group-label{font-weight:600;fill:var(--text)}.pb-graph-tables{display:grid;gap:14px;overflow:auto;max-height:420px}`;
  document.head.appendChild(st);

  const elOf = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
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
        ['From', 'To', 'Label', 'Highlighted', 'In a cycle'],
        state.edges.map((e) => [
          state.byId.get(e.from)?.label || e.from,
          state.byId.get(e.to)?.label || e.to,
          e.label || '—',
          e.highlight ? 'Yes' : 'No',
          e.inCycle ? 'Yes' : 'No',
        ]),
      ),
    );
    return wrap;
  };

  const prioritizedNodes = (state) => {
    if (state.nodes.length <= 48) return state.nodes;
    const degree = new Map(state.nodes.map(({ id }) => [id, 0]));
    for (const { from, to } of state.edges) {
      degree.set(from, degree.get(from) + 1);
      degree.set(to, degree.get(to) + 1);
    }
    const byValue = [...state.nodes].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const byDegree = [...state.nodes].sort((a, b) => degree.get(b.id) - degree.get(a.id));
    return new Set(byValue.slice(0, 24).flatMap((node, i) => [node, byDegree[i]]));
  };

  const labelCandidates = (state, regions) => [
    ...regions.map(({ group, lx, ly }) => ({ text: group.label, cls: 'pb-graph-label pb-graph-group-label', x: lx, y: ly, r: 0 })),
    ...Array.from(prioritizedNodes(state), ({ id, label, x, y, r }) => ({ text: label, cls: 'pb-graph-label', id, x, y, r })),
  ];

  const observers = new WeakMap();
  let seq = 0;

  const graphControls = (state) => {
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
    top.append(seg);

    return { top, leg, bGraph, bTable };
  };

  const mountGraph = (el, state, svg) => {
    const { top, leg, bGraph, bTable } = graphControls(state);
    const scroll = elOf('div', 'pb-graph-scroll');
    scroll.append(svg);
    const tables = elOf('div');
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
      else if (!tables.childElementCount) tables.append(buildTables(state));
    };
    bGraph.addEventListener('click', () => show('graph'));
    bTable.addEventListener('click', () => show('table'));

    observers.get(el)?.disconnect();
    el.replaceChildren(top, scroll, tables, leg);
    syncScrollTab();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(syncScrollTab);
      observer.observe(scroll);
      observers.set(el, observer);
    }
  };

  window.postbox.graph = async (el, spec) => {
    const layout = window.__pbGraphLayout;
    const { drawSvg, measureLabels } = window.__pbGraphSvg;
    const d3 = window.d3 || (await window.postbox.load('d3'));
    const state = layout.normalizeSpec(spec);
    window.__pbGraphEdges.markHighlights(state, spec?.highlight);
    layout.runForceLayout(d3, state);
    const regions = layout.groupRegions(d3, state.groups, state.nodes);
    el.classList.add('pb-graph');
    const candidates = measureLabels(labelCandidates(state, regions));
    const labels = window.__pbGraphLabels(candidates, state.nodes, state.width, state.height);
    mountGraph(el, state, drawSvg(state, regions, labels, `pbg-${++seq}`));
    return { nodes: state.nodes, edges: state.edges, groups: state.groups };
  };
}
