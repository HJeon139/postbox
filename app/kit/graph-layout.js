// Where postbox.graph’s nodes go (#888), preloaded before app/kit/graph.js, which reads the spec and draws: d3-force
// with each group pulled to a center of its own, then every node’s box (its circle and the label under it) pushed
// apart from every other until none overlap, a soft region around each group, and the whole moved to fit its frame.
// A block, not a function, keeps its names out of the app’s global scope: Biome counts an IIFE as one long function.
{
  const FONT = 13;
  const LINE = 16;
  const GAP = 12;

  // Text width at the graph’s font, from a canvas where there is one, else an estimate on the wide side.
  const measure = (() => {
    const ctx = document.createElement('canvas')?.getContext?.('2d');
    if (!ctx) return (text, bold) => text.length * (bold ? 8 : 7.5);
    return (text, bold) => {
      ctx.font = `${bold ? '600 ' : ''}${FONT}px system-ui, sans-serif`;
      return Math.ceil(ctx.measureText(text).width) + 2;
    };
  })();

  // The box a node and its label take, around the node’s center: the label sits under the circle.
  const box = (d) => {
    const half = Math.max(d.r, d.w / 2) + GAP / 2;
    return { x0: d.x - half, x1: d.x + half, y0: d.y - d.r - GAP / 2, y1: d.y + d.r + 3 + LINE + GAP / 2 };
  };

  /** Pushes every pair of overlapping boxes apart along the axis they overlap least, by share of the overlap. */
  const separate = (nodes, share) => {
    let moved = false;
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = box(nodes[i]);
        const b = box(nodes[j]);
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        // Along the axis that overlaps less; a pair centered on the same line moves the first node left or up.
        const axis = ox < oy ? 'x' : 'y';
        const before = axis === 'x' ? a.x0 + a.x1 <= b.x0 + b.x1 : a.y0 + a.y1 <= b.y0 + b.y1;
        const step = ((Math.min(ox, oy) + 0.5) / 2) * share * (before ? 1 : -1);
        nodes[i][axis] -= step;
        nodes[j][axis] += step;
      }
    return moved;
  };

  /** Pulls a cycle’s nodes toward evenly spaced points, clockwise in order, on a circle round their middle. */
  const pullToRing = (ring, alpha) => {
    const cx = ring.reduce((sum, d) => sum + d.x, 0) / ring.length;
    const cy = ring.reduce((sum, d) => sum + d.y, 0) / ring.length;
    const R = Math.max(48, ring.reduce((sum, d) => sum + Math.max(2 * d.r, d.w) + GAP * 2, 0) / (2 * Math.PI));
    ring.forEach((d, k) => {
      const a = -Math.PI / 2 + (2 * Math.PI * k) / ring.length;
      d.vx += (cx + Math.cos(a) * R - d.x) * alpha * 0.8;
      d.vy += (cy + Math.sin(a) * R - d.y) * alpha * 0.8;
    });
  };

  /** Lays the nodes out: d3-force with each group pulled to its own center, then overlaps pushed apart until none are left. */
  const place = (d3, g, W, H) => {
    const max = Math.max(0, ...g.nodes.map((n) => n.value ?? 0));
    const k = g.groups.length;
    const centers = g.groups.map((_, i) => {
      const a = Math.PI + (2 * Math.PI * i) / k;
      return k < 2 ? [W / 2, H / 2] : [W / 2 + Math.cos(a) * W * 0.27, H / 2 + Math.sin(a) * H * 0.24];
    });
    const sim = g.nodes.map((n, i) => {
      const [cx, cy] = centers[n.group] ?? [W / 2, H / 2];
      const r = n.value === undefined || !max ? 7 : 5 + 15 * Math.sqrt(n.value / max);
      return { i, r, w: measure(n.label), cx, cy, x: cx + Math.cos(i * 2.4) * 12 * Math.sqrt(i + 1), y: cy + Math.sin(i * 2.4) * 12 * Math.sqrt(i + 1) };
    });
    const same = (e) => g.nodes[e.source].group === g.nodes[e.target].group;
    const rings = (g.rings ?? []).map((ring) => ring.map((i) => sim[i]));
    const links = g.edges.filter((e) => e.source !== e.target).map((e) => ({ source: e.source, target: e.target, same: same(e) }));
    d3.forceSimulation(sim)
      .force(
        'link',
        d3
          .forceLink(links)
          .distance((l) => (l.same ? 90 : 180))
          .strength((l) => (l.same ? 0.5 : 0.04)),
      )
      .force('charge', d3.forceManyBody().strength(-380))
      .force('x', d3.forceX((d) => d.cx).strength(k > 1 ? 0.12 : 0.04))
      .force('y', d3.forceY((d) => d.cy).strength(k > 1 ? 0.07 : 0.04))
      .force('rings', (alpha) => {
        for (const ring of rings) pullToRing(ring, alpha);
      })
      .force('boxes', () => separate(sim, 0.4))
      .stop()
      .tick(300);
    for (let pass = 0; pass < 2000 && separate(sim, 1); pass++);
    return sim;
  };

  /** A soft region around each group’s nodes and labels, with the group’s name above it, kept clear of every label. */
  const regions = (d3, g, sim) => {
    const taken = sim.map(box);
    return g.groups.flatMap((grp, gi) => {
      const members = sim.filter((d) => g.nodes[d.i].group === gi);
      if (!members.length) return [];
      const pts = members.flatMap((d) => {
        const b = box(d);
        return [
          [b.x0 - 10, b.y0 - 10],
          [b.x1 + 10, b.y0 - 10],
          [b.x1 + 10, b.y1 + 6],
          [b.x0 - 10, b.y1 + 6],
        ];
      });
      const hull = d3.polygonHull(pts);
      const w = measure(grp.label, true);
      const x = d3.mean(hull, (p) => p[0]);
      let y = d3.min(hull, (p) => p[1]) - 8 - LINE;
      const at = () => ({ x0: x - w / 2 - 2, x1: x + w / 2 + 2, y0: y, y1: y + LINE });
      const hits = (a) => taken.some((b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1);
      for (let tries = 0; tries < 40 && hits(at()); tries++) y -= 8;
      taken.push(at());
      return [{ gi, label: grp.label, hull, x, y, box: at() }];
    });
  };
  /** Moves everything so it sits centered in W × H, or grows the size to fit it; returns the size. */
  const frame = (sim, groupMarks, W, H) => {
    const boxes = [...sim.map(box), ...groupMarks.map((m) => m.box)];
    const x0 = Math.min(...boxes.map((b) => b.x0)) - 16;
    const x1 = Math.max(...boxes.map((b) => b.x1)) + 16;
    const y0 = Math.min(...boxes.map((b) => b.y0)) - 16;
    const y1 = Math.max(...boxes.map((b) => b.y1)) + 24;
    const width = Math.ceil(Math.max(W, x1 - x0));
    const height = Math.ceil(Math.max(H, y1 - y0));
    const dx = (width - (x1 - x0)) / 2 - x0;
    const dy = (height - (y1 - y0)) / 2 - y0;
    for (const d of sim) [d.x, d.y] = [d.x + dx, d.y + dy];
    for (const m of groupMarks) {
      [m.x, m.y] = [m.x + dx, m.y + dy];
      m.hull = m.hull.map(([x, y]) => [x + dx, y + dy]);
    }
    return { width, height };
  };

  /** Lays out a graph read by graph.js, at W × H or larger: the nodes, each group’s region and the size it needs. */
  const layout = (d3, g, W, H) => {
    const sim = place(d3, g, W, H);
    const groupMarks = regions(d3, g, sim);
    const size = frame(sim, groupMarks, W, H);
    return { sim, groupMarks, size };
  };
  Object.assign(window.__pbKit, { graphLayout: { layout, FONT, LINE } });
}
