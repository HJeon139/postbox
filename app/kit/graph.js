// postbox.graph(el, { nodes, edges, groups?, highlight?, layout?, width?, height?, label? }), preloaded after app/kit/charts.js
// and app/kit/graph-layout.js in every agent-app sandbox (#888). The agent says what connects to what; the kit lays it
// out with d3-force, from the bundled d3, so a question about code structure or dependencies gets a network rather than
// labeled boxes:
// - the agent gives no positions: the kit places every node, as a model can’t lay out even a small graph blind
// - layout: "force" (the default) pulls a group’s nodes toward the group’s own center; "layered" puts each node on a
//   row by how far down the edges it is, a group to a column, for imports, calls and flow; either way a group sits
//   inside one soft region, labeled once
// - labels are 13 px, under their node, and nodes with their labels are pushed apart until none overlap
// - edges are arrows; highlight picks the ones drawn strong: "between-groups", "cycles", or a function of the edge.
//   Edges in a cycle, and an edge whose reverse is there too, curve the same way round, so a cycle reads as a loop
// - a node’s value sets its area
// It draws at the size it’s read, 1000 × 680 unless width and height say otherwise, growing to fit and scrolling
// sideways in a narrow window rather than shrinking its text, with a Table view of the edges. It resolves to the
// layout: { layout, crossings, nodes: [{ id, x, y, r, label: { x, y, width, height } }], width, height }, where crossings
// counts the pairs of edges that cross, so the app can say how tangled it is or try the other layout.
// A block, not a function, keeps its names out of the app’s global scope: Biome counts an IIFE as one long function.
{
  const { mount, esc, graphLayout } = window.__pbKit;
  const { FONT, LINE } = graphLayout;
  const MAX_NODES = 300;
  const MAX_GROUPS = 8;
  const MODES = ['between-groups', 'cycles'];
  const fail = (what) => {
    throw new Error(`postbox.graph: ${what}`);
  };
  let drawn = 0;

  const style = document.createElement('style');
  style.textContent = `.pb-graph-scroll{overflow-x:auto}.pb-chart .pb-graph-scroll svg{margin:0 auto}.pb-chart svg.pb-graph text{font:${FONT}px system-ui,sans-serif}
    .pb-chart svg.pb-graph text.pb-graph-group{font-weight:600}.pb-chart svg.pb-graph .pb-graph-label{paint-order:stroke;stroke:var(--bg);stroke-width:4px;stroke-linejoin:round}`;
  document.head.appendChild(style);

  /** Checks the spec and returns the graph with groups and edges resolved to indexes. Throws, naming what’s wrong. */
  const readGraph = (spec) => {
    if (!spec || !Array.isArray(spec.nodes) || !spec.nodes.length) fail('nodes must be a non-empty array of { id, label?, group?, value? }.');
    if (spec.nodes.length > MAX_NODES)
      fail(
        `${spec.nodes.length} nodes is more than the ${MAX_NODES} a network can show readably. Draw an adjacency matrix with postbox.charts.heatmap instead.`,
      );
    if (spec.edges !== undefined && !Array.isArray(spec.edges)) fail('edges must be an array of { source, target } or [source, target].');
    if (spec.highlight !== undefined && typeof spec.highlight !== 'function' && !MODES.includes(spec.highlight))
      fail(`highlight must be “between-groups”, “cycles” or a function of the edge, not ${String(spec.highlight)}.`);
    if (spec.layout !== undefined && !['force', 'layered'].includes(spec.layout)) fail(`layout must be “force” or “layered”, not ${String(spec.layout)}.`);
    const groups = readGroups(spec);
    const index = new Map();
    const nodes = spec.nodes.map((raw, i) => {
      const n = typeof raw === 'object' && raw !== null ? raw : { id: raw };
      const id = n.id;
      if ((typeof id !== 'string' && typeof id !== 'number') || id === '') fail(`node ${i + 1} needs an id, a string or a number.`);
      if (index.has(String(id))) fail(`two nodes have the id “${id}”; each id names one node.`);
      index.set(String(id), i);
      if (n.value !== undefined && !(Number.isFinite(n.value) && n.value >= 0))
        fail(`node “${id}” has value ${JSON.stringify(n.value)}; a value is a number 0 or more.`);
      let group = -1;
      if (n.group !== undefined && n.group !== null) {
        group = groups.findIndex((g) => g.id === String(n.group));
        if (group < 0) fail(`node “${id}” is in the group “${n.group}”, which isn’t in groups.`);
      }
      return { id, label: String(n.label ?? id), group, value: n.value };
    });
    const edges = (spec.edges ?? []).map((raw, i) => {
      const e = Array.isArray(raw) ? { source: raw[0], target: raw[1] } : (raw ?? {});
      const end = (k) => {
        const at = index.get(String(e[k]));
        if (at === undefined) fail(`edge ${i + 1} has ${k} “${e[k]}”, which isn’t a node’s id.`);
        return at;
      };
      return { source: end('source'), target: end('target'), mark: !!e.highlight, raw: e };
    });
    return { nodes, edges, groups };
  };

  /** Groups as given, or in the order the nodes first name them. */
  const readGroups = (spec) => {
    if (spec.groups !== undefined && !Array.isArray(spec.groups)) fail('groups must be an array of ids or { id, label }.');
    const listed = spec.groups ?? [...new Set(spec.nodes.map((n) => n?.group).filter((g) => g !== undefined && g !== null))];
    if (listed.length > MAX_GROUPS) fail(`${listed.length} groups is more than the ${MAX_GROUPS} colors there are for them; merge the smallest.`);
    return listed.map((g) => {
      const id = String(typeof g === 'object' && g !== null ? g.id : g);
      return { id, label: String((typeof g === 'object' && g?.label) || id) };
    });
  };

  /**
   * The strongly connected components (Tarjan): the indexes of edges that lie on a cycle, with both ends in one
   * component or on a self-loop, and each component of three or more nodes in the order its depth-first search met
   * them, which for a plain cycle is the order round it. graph-layout.js draws those as rings.
   */
  const cycles = (n, edges) => {
    const out = Array.from({ length: n }, () => []);
    for (const e of edges) out[e.source].push(e.target);
    const order = new Array(n).fill(-1);
    const low = new Array(n).fill(0);
    const comp = new Array(n).fill(-1);
    const rings = [];
    const stack = [];
    let next = 0;
    let comps = 0;
    const visit = (v) => {
      order[v] = low[v] = next++;
      stack.push(v);
      for (const w of out[v]) {
        if (order[w] < 0) {
          visit(w);
          low[v] = Math.min(low[v], low[w]);
        } else if (comp[w] < 0) low[v] = Math.min(low[v], order[w]);
      }
      if (low[v] !== order[v]) return;
      const ring = [];
      for (let w = -1; w !== v; ) {
        w = stack.pop();
        comp[w] = comps;
        ring.unshift(w);
      }
      if (ring.length > 2) rings.push(ring);
      comps++;
    };
    for (let v = 0; v < n; v++) if (order[v] < 0) visit(v);
    const size = new Array(comps).fill(0);
    for (const c of comp) size[c]++;
    const onCycle = edges.flatMap((e, i) => (comp[e.source] === comp[e.target] && (size[comp[e.source]] > 1 || e.source === e.target) ? [i] : []));
    return { edges: new Set(onCycle), rings };
  };

  /** Which edges are drawn strong: those the highlight mode picks, and any marked highlight: true. */
  const strongEdges = (g, highlight, onCycle) => {
    const pick = (e, i) => {
      if (highlight === 'cycles') return onCycle.has(i);
      if (highlight === 'between-groups') return g.nodes[e.source].group !== g.nodes[e.target].group;
      return typeof highlight === 'function' && !!highlight({ ...e.raw, source: g.nodes[e.source].id, target: g.nodes[e.target].id });
    };
    return new Set(g.edges.flatMap((e, i) => (e.mark || pick(e, i) ? [i] : [])));
  };

  /** The path of one edge, from the edge of its source’s circle to just short of its target’s, curved when bend isn’t 0. */
  const edgePath = (s, t, bend) => {
    if (s === t) {
      const r = s.r;
      return `M${s.x + r * 0.7},${s.y - r * 0.7}C${s.x + r + 22},${s.y - r - 28} ${s.x - r - 22},${s.y - r - 28} ${s.x - r * 0.7},${s.y - r * 0.9}`;
    }
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const len = Math.hypot(dx, dy) || 1;
    const cx = (s.x + t.x) / 2 - (dy / len) * len * bend;
    const cy = (s.y + t.y) / 2 + (dx / len) * len * bend;
    const toward = (p, q, by) => {
      const l = Math.hypot(q[0] - p.x, q[1] - p.y) || 1;
      return [p.x + ((q[0] - p.x) / l) * by, p.y + ((q[1] - p.y) / l) * by];
    };
    const [sx, sy] = toward(s, [cx, cy], s.r + 2);
    const [ex, ey] = toward(t, [cx, cy], t.r + 3);
    return `M${sx.toFixed(1)},${sy.toFixed(1)}Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`;
  };

  // A group’s own color; a node in no group is gray when others have groups.
  const color = (g, gi) => {
    if (!g.groups.length) return 'var(--s1)';
    return gi < 0 ? 'var(--dim)' : `var(--s${gi + 1})`;
  };
  const strongName = (spec) => spec.highlightLabel || { 'between-groups': 'Between groups', cycles: 'In a cycle' }[spec.highlight] || 'Highlighted';

  /** The SVG: regions, then edges (strong ones last), then nodes and their labels. */
  const draw = (d3, g, sim, groupMarks, look, size, label, room) => {
    const curve = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.5));
    const id = `pb-graph-${++drawn}`;
    const head = (name, fill) =>
      `<marker id="${id}-${name}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0L10,5L0,10z" fill="${fill}"/></marker>`;
    let s = `<defs>${head('weak', 'var(--dim)')}${head('strong', 'var(--text)')}</defs>`;
    for (const m of groupMarks)
      s += `<path d="${curve(m.hull)}" fill="${color(g, m.gi)}" fill-opacity="0.12" stroke="${color(g, m.gi)}" stroke-opacity="0.35"/><text class="pb-graph-group" x="${m.x.toFixed(1)}" y="${m.y.toFixed(1)}" dominant-baseline="hanging" text-anchor="middle" fill="var(--text)">${esc(m.label)}</text>`;
    const reverse = new Set(g.edges.map((e) => `${e.source}>${e.target}`));
    const order = g.edges.map((e, i) => ({ e, i, strong: look.strong.has(i) })).sort((a, b) => a.strong - b.strong);
    for (const { e, i, strong } of order) {
      // Negative bows an edge to its right: outward round graph-layout.js’s clockwise rings, apart from its reverse.
      const bend = look.cycles.has(i) || reverse.has(`${e.target}>${e.source}`) ? -0.22 : 0;
      const how = strong ? 'stroke="var(--text)" stroke-width="2.25"' : 'stroke="var(--dim)" stroke-width="1.25" stroke-opacity="0.6"';
      s += `<path d="${edgePath(sim[e.source], sim[e.target], bend)}" fill="none" ${how} marker-end="url(#${id}-${strong ? 'strong' : 'weak'})"><title>${esc(g.nodes[e.source].label)} → ${esc(g.nodes[e.target].label)}</title></path>`;
    }
    for (const d of sim) {
      const n = g.nodes[d.i];
      const tip = [n.label, g.groups[n.group]?.label, n.value === undefined ? '' : `value ${n.value}`].filter(Boolean).join(' · ');
      s += `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r.toFixed(1)}" fill="${color(g, n.group)}" stroke="var(--bg)" stroke-width="2"><title>${esc(tip)}</title></circle>`;
      s += `<text class="pb-graph-label" x="${d.x.toFixed(1)}" y="${(d.y + d.r + 3).toFixed(1)}" dominant-baseline="hanging" text-anchor="middle" fill="var(--text)">${esc(n.label)}</text>`;
    }
    const svg = `<svg class="pb-graph" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}" role="img" aria-label="${esc(label)}">${s}</svg>`;
    const fit = room ? ` style="max-height:${room}px"` : '';
    return `<div class="pb-graph-scroll"${fit} tabindex="0" role="group" aria-label="${esc(label)}, scrolls when the window is narrow">${svg}</div>`;
  };

  /** The legend for strong edges, when there are any; groups are named on the picture. */
  const legend = (spec, look) => {
    if (!look.strong.size) return '';
    return `<div class="pb-legend"><span><i class="lk" style="background:var(--text);height:3px"></i>${esc(strongName(spec))}</span><span><i class="lk" style="background:var(--dim)"></i>Other edges</span></div>`;
  };

  window.postbox.graph = async (el, spec) => {
    const g = readGraph(spec);
    const W = Math.max(320, Number(spec.width) || 1000);
    // An element the app gave a height of its own: draw to fit inside it, less the view switch and legend, and scroll
    // there rather than spill over what follows it (the shop-split UAT run on #893).
    const room = el.clientHeight > 0 && !el.children?.length ? Math.max(200, el.clientHeight - 90) : 0;
    const H = Math.max(240, Number(spec.height) || room || 680);
    const d3 = await window.postbox.load('d3');
    const onCycle = cycles(g.nodes.length, g.edges);
    g.rings = onCycle.rings;
    const look = { strong: strongEdges(g, spec.highlight, onCycle.edges), cycles: onCycle.edges };
    const { sim, groupMarks, size, crossings } = graphLayout.layout(d3, g, W, H, spec.layout === 'layered');
    const label = spec.label || `Network of ${g.nodes.length} nodes${g.groups.length ? ` in ${g.groups.length} groups` : ''}`;
    const html = legend(spec, look) + draw(d3, g, sim, groupMarks, look, size, label, room);
    const rows = g.edges.map((e, i) => {
      const [a, b] = [g.nodes[e.source], g.nodes[e.target]];
      const row = [a.label, b.label];
      if (g.groups.length) row.push(g.groups[a.group]?.label ?? '', g.groups[b.group]?.label ?? '');
      return look.strong.size ? [...row, look.strong.has(i) ? 'Yes' : ''] : row;
    });
    const header = ['From', 'To', ...(g.groups.length ? ['From group', 'To group'] : []), ...(look.strong.size ? [strongName(spec)] : [])];
    mount(el, () => html, [header, ...rows], label);
    return {
      layout: spec.layout === 'layered' ? 'layered' : 'force',
      crossings,
      width: size.width,
      height: size.height,
      nodes: sim.map((d) => ({ id: g.nodes[d.i].id, x: d.x, y: d.y, r: d.r, label: { x: d.x - d.w / 2, y: d.y + d.r + 3, width: d.w, height: LINE } })),
    };
  };
}
