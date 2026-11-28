// Pure layout, cycle detection, group clustering, and label de-overlap helpers for postbox.graph (#888).
// Inlined before app/kit/graph.js in every app sandbox page; uses a block scope so nothing leaks to app globals.

{
  /** Finds every directed edge that belongs to a cycle (Tarjan SCCs with size > 1, plus self-loops). */
  const findCycleEdges = (nodes, edges) => {
    const adj = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) adj.get(e.from)?.push(e.to);
    let idx = 0;
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const comp = new Map();
    let cid = 0;
    const visit = (v) => {
      index.set(v, idx);
      low.set(v, idx++);
      stack.push(v);
      onStack.add(v);
      for (const w of adj.get(v) || []) {
        if (!index.has(w)) {
          visit(w);
          low.set(v, Math.min(low.get(v), low.get(w)));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
      }
      if (low.get(v) === index.get(v)) {
        const members = [];
        let w;
        do {
          w = stack.pop();
          onStack.delete(w);
          members.push(w);
        } while (w !== v);
        if (members.length > 1) {
          cid++;
          for (const m of members) comp.set(m, cid);
        }
      }
    };
    for (const n of nodes) if (!index.has(n.id)) visit(n.id);
    return new Set(edges.filter((e) => e.from === e.to || (comp.has(e.from) && comp.get(e.from) === comp.get(e.to))));
  };

  /** Normalizes user-supplied graph spec into clean nodes, edges, and categorical group tokens (--s1..--s8). */
  const normalizeSpec = (spec) => {
    const width = Math.max(360, Number(spec?.width) || 960);
    const height = Math.max(260, Number(spec?.height) || 540);
    const rawNodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
    const rawEdges = Array.isArray(spec?.edges) ? spec.edges : [];
    const groupMap = new Map();
    const addGroup = (id, label) => {
      if (id == null || id === '') return;
      const key = String(id);
      if (!groupMap.has(key)) groupMap.set(key, { id: key, label: String(label ?? key), color: `s${(groupMap.size % 8) + 1}` });
    };
    if (Array.isArray(spec?.groups)) {
      for (const g of spec.groups) {
        if (typeof g === 'string') addGroup(g, g);
        else if (g && typeof g === 'object') addGroup(g.id ?? g.name, g.label ?? g.name ?? g.id);
      }
    } else if (spec?.groups && typeof spec.groups === 'object') {
      for (const [k, v] of Object.entries(spec.groups)) addGroup(k, typeof v === 'string' ? v : v?.label ?? k);
    }
    for (const n of rawNodes) if (n?.group != null) addGroup(n.group, n.group);

    const vals = rawNodes.map((n) => Number(n?.value)).filter((v) => Number.isFinite(v) && v > 0);
    const maxVal = vals.length ? Math.max(...vals) : 0;
    const minVal = vals.length ? Math.min(...vals) : 0;
    const radiusOf = (v) => {
      if (!maxVal || !Number.isFinite(v) || v <= 0) return 9;
      if (maxVal === minVal) return 11;
      const t = Math.sqrt((v - minVal) / (maxVal - minVal));
      return Math.round((7 + t * 11) * 10) / 10;
    };

    const byId = new Map();
    const nodes = [];
    for (const n of rawNodes) {
      if (!n || n.id == null) continue;
      const id = String(n.id);
      if (byId.has(id)) continue;
      const label = String(n.label ?? id);
      const group = n.group != null && n.group !== '' ? String(n.group) : null;
      const value = Number.isFinite(Number(n.value)) && Number(n.value) > 0 ? Number(n.value) : null;
      const node = { id, label, group, value, r: radiusOf(value ?? 0), color: group ? groupMap.get(group)?.color || 's1' : 's1', x: 0, y: 0 };
      byId.set(id, node);
      nodes.push(node);
    }

    const edges = [];
    for (const e of rawEdges) {
      if (!e) continue;
      const from = String(e.from ?? e.source ?? '');
      const to = String(e.to ?? e.target ?? '');
      if (!byId.has(from) || !byId.has(to)) continue;
      edges.push({
        from,
        to,
        source: from,
        target: to,
        label: e.label != null ? String(e.label) : '',
        highlight: Boolean(e.highlight),
        inCycle: false,
        sameGroup: byId.get(from).group === byId.get(to).group,
      });
    }
    return { width, height, nodes, edges, groups: [...groupMap.values()], byId, label: String(spec?.label || 'Network graph') };
  };

  /** Marks cycle and highlighted edges according to spec.highlight ('cross-group' | 'cycles' | list | object). */
  const markHighlights = (state, highlight) => {
    const cycles = findCycleEdges(state.nodes, state.edges);
    for (const e of cycles) e.inCycle = true;
    const mode = typeof highlight === 'string' ? highlight : highlight?.mode || null;
    const explicit = Array.isArray(highlight) ? highlight : Array.isArray(highlight?.edges) ? highlight.edges : [];
    const pairs = new Set(explicit.map((x) => `${x?.from ?? x?.source ?? ''}->${x?.to ?? x?.target ?? ''}`));
    for (const e of state.edges) {
      if (mode === 'cross-group' && !e.sameGroup) e.highlight = true;
      if (mode === 'cycles' && e.inCycle) e.highlight = true;
      if (pairs.has(`${e.from}->${e.to}`)) e.highlight = true;
    }
  };

  /** Computes cluster anchor positions for each group across the canvas. */
  const groupCenters = (groups, width, height) => {
    const centers = new Map();
    const padX = Math.min(180, width * 0.22);
    const padY = Math.min(130, height * 0.22);
    if (groups.length === 1) {
      centers.set(groups[0].id, { x: width / 2, y: height / 2 });
    } else if (groups.length === 2) {
      centers.set(groups[0].id, { x: width * 0.28, y: height * 0.52 });
      centers.set(groups[1].id, { x: width * 0.72, y: height * 0.52 });
    } else {
      const rx = (width - padX * 2) / 2;
      const ry = (height - padY * 2) / 2;
      groups.forEach((g, i) => {
        const a = (i / groups.length) * Math.PI * 2 - Math.PI / 2;
        centers.set(g.id, { x: width / 2 + Math.cos(a) * rx, y: height / 2 + Math.sin(a) * ry });
      });
    }
    return centers;
  };

  /** Runs d3-force synchronously from deterministic seeded positions so the layout is crisp with no animation. */
  const runForceLayout = (d3, state) => {
    const { width, height, nodes, edges, groups } = state;
    const centers = groupCenters(groups, width, height);
    const byGroup = new Map();
    for (const n of nodes) {
      const key = n.group ?? '__none';
      const idx = byGroup.get(key) || 0;
      byGroup.set(key, idx + 1);
      const c = centers.get(n.group) || { x: width / 2, y: height / 2 };
      const angle = idx * 2.3999632; // golden angle
      const dist = 28 + Math.sqrt(idx) * 34;
      n.x = c.x + Math.cos(angle) * dist;
      n.y = c.y + Math.sin(angle) * dist;
      if (!(n.labelW > 0)) n.labelW = Math.max(28, n.label.length * 7.2 + 8);
      if (!(n.labelH > 0)) n.labelH = 16;
    }
    const sim = d3
      .forceSimulation(nodes)
      .force(
        'link',
        d3
          .forceLink(edges)
          .id((d) => d.id)
          .distance((e) => (e.sameGroup ? 92 : 195))
          .strength((e) => (e.sameGroup ? 0.5 : 0.12)),
      )
      .force('charge', d3.forceManyBody().strength(-360))
      .force(
        'collide',
        d3.forceCollide().radius((d) => d.r + Math.min(64, Math.max(28, d.labelW * 0.48))),
      )
      .force(
        'x',
        d3.forceX((d) => (centers.get(d.group)?.x ?? width / 2)).strength((d) => (d.group ? 0.22 : 0.06)),
      )
      .force(
        'y',
        d3.forceY((d) => (centers.get(d.group)?.y ?? height / 2)).strength((d) => (d.group ? 0.22 : 0.06)),
      )
      .stop();
    for (let i = 0; i < 280; i++) sim.tick();
    const padX = 56;
    const padTop = 54;
    const padBottom = 38;
    for (const n of nodes) {
      n.x = Math.max(padX, Math.min(width - padX, n.x));
      n.y = Math.max(padTop, Math.min(height - padBottom, n.y));
    }
  };

  /** Runs pairwise label relaxation inside width × height; returns true once no two boxes overlap. */
  const relaxLabels = (labels, width, height, gap) => {
    for (let pass = 0; pass < 80; pass++) {
      let moved = false;
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const a = labels[i];
          const b = labels[j];
          const ox = (a.w + b.w) / 2 + gap - Math.abs(a.x - b.x);
          const oy = (a.h + b.h) / 2 + gap - Math.abs(a.y - b.y);
          if (ox > 0 && oy > 0) {
            moved = true;
            if (oy <= ox) {
              const dy = (oy / 2 + 0.5) * (a.y <= b.y ? -1 : 1);
              a.y += dy;
              b.y -= dy;
            } else {
              const dx = (ox / 2 + 0.5) * (a.x <= b.x ? -1 : 1);
              a.x += dx;
              b.x -= dx;
            }
          }
        }
      }
      for (const l of labels) {
        const halfW = Math.min(l.w / 2, width / 2 - 8);
        l.x = Math.max(halfW + 8, Math.min(width - halfW - 8, l.x));
        l.y = Math.max(Math.max(24, l.h + 4), Math.min(height - 8, l.y));
      }
      if (!moved) return true;
    }
    return false;
  };

  /** Places 12 px node labels, growing drawing height when dense labels still overlap after relaxation. */
  const placeLabels = (nodes, width, height) => {
    const gap = 4;
    let curH = height;
    const seed = () =>
      nodes.map((n) => {
        const w = n.labelW || 28;
        const h = n.labelH || 16;
        const halfW = Math.min(w / 2, width / 2 - 8);
        return { node: n, w, h, x: Math.max(halfW + 8, Math.min(width - halfW - 8, n.x)), y: Math.min(curH - 10, n.y + n.r + 14) };
      });
    let labels = seed();
    let clear = relaxLabels(labels, width, curH, gap);
    for (let grow = 0; !clear && grow < 6; grow++) {
      const nextH = Math.ceil(curH * 1.45) + 48;
      const scale = (nextH - 92) / Math.max(1, curH - 92);
      for (const n of nodes) n.y = 54 + (n.y - 54) * scale;
      curH = nextH;
      labels = seed();
      clear = relaxLabels(labels, width, curH, gap);
    }
    if (!clear) {
      const placed = [];
      for (const l of [...labels].sort((a, b) => a.y - b.y || a.x - b.x)) {
        for (let bumped = true; bumped; ) {
          bumped = false;
          for (const p of placed) {
            if (Math.abs(l.x - p.x) < (l.w + p.w) / 2 + gap && Math.abs(l.y - p.y) < (l.h + p.h) / 2 + gap) {
              l.y = p.y + (l.h + p.h) / 2 + gap;
              bumped = true;
            }
          }
        }
        placed.push(l);
        curH = Math.max(curH, Math.ceil(l.y + 12));
      }
    }
    labels.height = curH;
    return labels;
  };

  /** Soft padded bounding region around each group’s nodes (one soft cluster shape, never a box per node). */
  const groupRegions = (d3, groups, nodes) => {
    const pad = 34;
    const out = [];
    for (const g of groups) {
      const members = nodes.filter((n) => n.group === g.id);
      if (!members.length) continue;
      let d = '';
      let lx = 0;
      let ly = 0;
      if (members.length >= 3) {
        const pts = members.map((n) => [n.x, n.y]);
        const hull = d3.polygonHull(pts);
        if (hull) {
          const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
          const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
          const expanded = hull.map(([x, y]) => {
            const dx = x - cx;
            const dy = y - cy;
            const len = Math.hypot(dx, dy) || 1;
            return [x + (dx / len) * pad, y + (dy / len) * pad];
          });
          d = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.5))(expanded) || '';
          lx = Math.min(...expanded.map((p) => p[0])) + 10;
          ly = Math.min(...expanded.map((p) => p[1])) - 8;
        }
      }
      if (!d) {
        const xs = members.map((n) => n.x);
        const ys = members.map((n) => n.y);
        const x0 = Math.min(...xs) - pad;
        const y0 = Math.min(...ys) - pad;
        const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
        const h = Math.max(...ys) - Math.min(...ys) + pad * 2;
        const r = Math.min(24, w / 2, h / 2);
        d = `M${x0 + r},${y0}H${x0 + w - r}A${r},${r} 0 0 1 ${x0 + w},${y0 + r}V${y0 + h - r}A${r},${r} 0 0 1 ${x0 + w - r},${y0 + h}H${x0 + r}A${r},${r} 0 0 1 ${x0},${y0 + h - r}V${y0 + r}A${r},${r} 0 0 1 ${x0 + r},${y0}Z`;
        lx = x0 + 10;
        ly = y0 - 8;
      }
      out.push({ group: g, d, lx, ly: Math.max(16, ly) });
    }
    return out;
  };

  window.__pbGraphLayout = { normalizeSpec, markHighlights, runForceLayout, placeLabels, groupRegions };
}
