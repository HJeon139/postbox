// SVG marks and text measurement for postbox.graph (#888).
{
  const SVG_NS = 'http://www.w3.org/2000/svg';
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
    let bend = e.sameGroup ? 8 : 16;
    if (e.inCycle) bend = 20;
    if (hasReverse) bend = 24;
    const mx = (sx + tx) / 2 - uy * bend;
    const my = (sy + ty) / 2 + ux * bend;
    return `M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)}`;
  };

  const drawEdges = (state, uid) => {
    const pairSet = new Set(state.edges.map((e) => `${e.source.id}->${e.target.id}`));
    const edgeG = svgEl('g', { class: 'pb-graph-edges' });
    for (const e of state.edges) {
      const cycleHi = e.inCycle && e.highlight;
      let style = { stroke: 'var(--dim)', marker: 'arr' };
      if (e.highlight) style = { stroke: 'var(--text)', marker: 'hi' };
      if (cycleHi) style = { stroke: 'var(--alert)', marker: 'cyc' };
      edgeG.append(
        svgEl('path', {
          d: edgePath(e, pairSet),
          fill: 'none',
          stroke: style.stroke,
          'stroke-opacity': e.highlight ? '0.95' : '1',
          'stroke-dasharray': cycleHi ? '6 3' : null,
          'stroke-width': e.highlight ? '2.2' : '1.3',
          'marker-end': `url(#${uid}-${style.marker})`,
          'data-edge': `${e.from}->${e.to}`,
          ...(e.highlight ? { 'data-highlight': '1' } : {}),
        }),
      );
    }
    return edgeG;
  };

  const drawLabels = (labels) => {
    const labelG = svgEl('g', { class: 'pb-graph-labels' });
    for (const l of labels) {
      labelG.append(svgEl('text', { x: l.x.toFixed(1), y: l.y.toFixed(1), 'text-anchor': 'middle', class: l.cls, 'data-node-label': l.id }, l.text));
    }
    return labelG;
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
      );
    }
    svg.append(regionG);

    svg.append(drawEdges(state, uid));

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

    svg.append(drawLabels(labels));
    return svg;
  };

  /** Measure the candidates using the fonts that will draw their labels. */
  const measureLabels = (candidates) => {
    const measuring = document.createElement('div');
    measuring.className = 'pb-graph';
    const svg = svgEl('svg', { style: 'position:fixed;visibility:hidden;pointer-events:none' });
    const texts = candidates.map(({ cls, text }) => svgEl('text', { class: cls }, text));
    for (const text of texts) svg.append(text);
    measuring.append(svg);
    document.body.append(measuring);
    const measured = candidates.map((candidate, i) => {
      const box = texts[i].getBBox();
      return { ...candidate, w: box.width + 6, h: Math.max(16, -box.y + 4) };
    });
    measuring.remove();
    return measured;
  };

  window.__pbGraphSvg = { drawSvg, measureLabels };
}
