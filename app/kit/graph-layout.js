// Spec normalization and group clustering helpers for postbox.graph (#888).
// Inlined before app/kit/graph.js in every app sandbox page; uses a block scope so nothing leaks to app globals.

{
  const normalizeGroups = (groups, rawNodes) => {
    const groupMap = new Map();
    const addGroup = (id, label) => {
      if (id == null || id === '') return;
      const key = String(id);
      if (!groupMap.has(key)) groupMap.set(key, { id: key, label: String(label ?? key), color: `s${(groupMap.size % 8) + 1}` });
    };
    if (Array.isArray(groups)) {
      for (const g of groups) {
        if (typeof g === 'string') addGroup(g, g);
        else if (g && typeof g === 'object') addGroup(g.id ?? g.name, g.label ?? g.name ?? g.id);
      }
    } else if (groups && typeof groups === 'object') {
      for (const [k, v] of Object.entries(groups)) addGroup(k, typeof v === 'string' ? v : (v?.label ?? k));
    }
    for (const n of rawNodes) if (n?.group != null) addGroup(n.group, n.group);

    return groupMap;
  };

  const nodeRadius = (rawNodes) => {
    let minVal = Infinity;
    let maxVal = 0;
    for (const node of rawNodes) {
      const value = Number(node?.value);
      if (!Number.isFinite(value) || value <= 0) continue;
      minVal = Math.min(minVal, value);
      maxVal = Math.max(maxVal, value);
    }
    return (v) => {
      if (!maxVal || !Number.isFinite(v) || v <= 0) return 9;
      if (maxVal === minVal) return 11;
      const t = Math.sqrt((v - minVal) / (maxVal - minVal));
      return Math.round((7 + t * 11) * 10) / 10;
    };
  };

  // Keep drawing coordinates within the SVG and label grid’s practical range.
  const dimension = (input, fallback, min) => {
    const value = Number(input);
    return Number.isFinite(value) && value !== 0 ? Math.max(min, Math.min(16_384, value)) : fallback;
  };

  /** Normalizes user-supplied graph spec into clean nodes, edges, and categorical group tokens (--s1..--s8). */
  const normalizeSpec = (spec) => {
    const width = dimension(spec?.width, 960, 360);
    const height = dimension(spec?.height, 540, 260);
    const rawNodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
    const rawEdges = Array.isArray(spec?.edges) ? spec.edges : [];
    const groupMap = normalizeGroups(spec?.groups, rawNodes);
    const radiusOf = nodeRadius(rawNodes);
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
      const key = n.group;
      const idx = byGroup.get(key) || 0;
      byGroup.set(key, idx + 1);
      const c = centers.get(n.group) || { x: width / 2, y: height / 2 };
      const angle = idx * 2.3999632; // golden angle
      const dist = 28 + Math.sqrt(idx) * 34;
      n.x = c.x + Math.cos(angle) * dist;
      n.y = c.y + Math.sin(angle) * dist;
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
      .force('charge', d3.forceManyBody().strength(nodes.length <= 60 ? -360 : -95))
      .force(
        'collide',
        d3.forceCollide().radius((d) => d.r + (nodes.length <= 60 ? 28 : 4)),
      )
      .force(
        'x',
        d3.forceX((d) => centers.get(d.group)?.x ?? width / 2).strength((d) => (d.group ? 0.22 : 0.06)),
      )
      .force(
        'y',
        d3.forceY((d) => centers.get(d.group)?.y ?? height / 2).strength((d) => (d.group ? 0.22 : 0.06)),
      )
      .stop();
    sim.tick(Math.min(180, Math.max(8, Math.floor(40_000 / (nodes.length + edges.length || 1)))));
    fitDrawing(nodes, width, height);
  };

  const fitDrawing = (nodes, width, height) => {
    const bounds = { left: 56, right: width - 56, top: 54, bottom: height - 38 };
    let { left, right, top, bottom } = bounds;
    for (const { x, y } of nodes) {
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    for (const node of nodes) {
      node.x = bounds.left + ((node.x - left) / (right - left)) * (bounds.right - bounds.left);
      node.y = bounds.top + ((node.y - top) / (bottom - top)) * (bounds.bottom - bounds.top);
    }
  };

  /** Soft padded bounding region around each group’s nodes (one soft cluster shape, never a box per node). */
  const groupRegions = (d3, groups, nodes) => {
    const pad = 34;
    const out = [];
    const byGroup = new Map(groups.map((group) => [group.id, []]));
    for (const node of nodes) byGroup.get(node.group)?.push(node);
    for (const g of groups) {
      const members = byGroup.get(g.id);
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

  window.__pbGraphLayout = { normalizeSpec, runForceLayout, groupRegions };
}
