// Cycle detection and edge highlighting for postbox.graph (#888).
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
    const enter = (v) => {
      index.set(v, idx);
      low.set(v, idx++);
      stack.push(v);
      onStack.add(v);
      return { v, next: 0 };
    };
    const finish = (v) => {
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
    for (const { id } of nodes) {
      if (index.has(id)) continue;
      const path = [enter(id)];
      while (path.length) {
        const frame = path.at(-1);
        const { v } = frame;
        const neighbors = adj.get(v);
        if (frame.next < neighbors.length) {
          const w = neighbors[frame.next++];
          if (!index.has(w)) path.push(enter(w));
          else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
        } else {
          finish(v);
          path.pop();
          const parent = path.at(-1)?.v;
          if (parent !== undefined) low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
      }
    }
    return new Set(edges.filter((e) => e.from === e.to || (comp.has(e.from) && comp.get(e.from) === comp.get(e.to))));
  };

  /** Marks cycle and highlighted edges according to spec.highlight ('cross-group' | 'cycles' | list | object). */
  const markHighlights = (state, highlight) => {
    const cycles = findCycleEdges(state.nodes, state.edges);
    for (const e of cycles) e.inCycle = true;
    const mode = typeof highlight === 'string' ? highlight : highlight?.mode || null;
    const explicit = Array.isArray(highlight) ? highlight : highlight?.edges;
    const pairs = new Set((Array.isArray(explicit) ? explicit : []).map((x) => `${x?.from ?? x?.source ?? ''}->${x?.to ?? x?.target ?? ''}`));
    for (const e of state.edges) {
      if (mode === 'cross-group' && !e.sameGroup) e.highlight = true;
      if (mode === 'cycles' && e.inCycle) e.highlight = true;
      if (pairs.has(`${e.from}->${e.to}`)) e.highlight = true;
    }
  };

  window.__pbGraphHighlights = markHighlights;
}
