// The diagram linter: finds Mermaid diagrams people won’t be able to read, so their agent can redraw them.
//
// A diagram is scaled down to fit the conversation’s column, so the usual way it fails is quiet: a long chain
// of boxes side by side, one very wide list, or long labels make it wide, and its text shrinks until it can’t
// be read. This estimates the width Mermaid would lay a diagram out at, from its source, and from that the
// size its text ends up at. It also flags diagrams with too many parts to follow at once.
//
// It’s an estimate, deliberately simple and conservative. The browser measures the real text size after a
// diagram renders (app/kit/diagram.js) and reports what this misses. Pure, so the tests and both sides can use it.

import { stripTags } from './markdown-inline.mjs';

/** The size Postbox draws diagram text at, and the smallest size people can read. */
export const DIAGRAM_TEXT_PX = 13;
export const MIN_TEXT_PX = 10;
/** The width a diagram gets in a conversation. */
export const COLUMN_PX = 728;

const MAX_PARTS = 30;
const MAX_SIDE_BY_SIDE = 8;
const MAX_MESSAGES = 40;
const MAX_PARTICIPANTS = 6;
// Mermaid’s layout as Postbox renders it, in px, fitted to measurements of rendered diagrams in Chrome
// (see tests/diagram-lint.test.mjs): text width per character, the width labels wrap at, and a box’s padding.
const CHAR_PX = 8.5;
const WRAP_PX = 200;
const NODE_PAD = 56;
const NODE_GAP = 50;
const RANK_GAP = 50;

/** The closed ```mermaid fences in a Markdown text, in order. */
export function mermaidBlocks(markdown) {
  return [...String(markdown ?? '').matchAll(/^ {0,3}```mermaid[^\n]*\n([\s\S]*?)\n {0,3}```/gm)].map((m, index) => ({ index, src: m[1] }));
}

const clean = (s) =>
  stripTags(
    String(s ?? '')
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/<br\s*\/?>/gi, '\n'),
  )
    .replace(/[*_`]/g, '')
    .trim();
const longestLine = (s) =>
  Math.max(
    0,
    ...clean(s)
      .split('\n')
      .map((l) => l.length),
  );
const boxWidth = (label) => Math.min(longestLine(label) * CHAR_PX, WRAP_PX) + NODE_PAD;
const labelWidth = (label) => (label ? Math.min(longestLine(label) * CHAR_PX, WRAP_PX) + 10 : 0);

// ── Flowcharts ─────────────────────────────────────────────────────────────────────────

const SHAPES = [
  ['[[', ']]'],
  ['[(', ')]'],
  ['((', '))'],
  ['([', '])'],
  ['{{', '}}'],
  ['[/', '/]'],
  ['[\\', '\\]'],
  ['[', ']'],
  ['(', ')'],
  ['{', '}'],
  ['>', ']'],
];

/** One node expression, such as A, A[Label] or A((Label)), to { id, label }. */
function parseNode(expr) {
  const m = /^([A-Za-z0-9_][\w-]*)\s*(.*)$/.exec(expr.trim());
  if (!m) return null;
  const [, id, rest] = m;
  if (!rest) return { id, label: null };
  for (const [open, close] of SHAPES)
    if (rest.startsWith(open) && rest.endsWith(close)) return { id, label: rest.slice(open.length, rest.length - close.length) };
  return { id, label: null };
}

// An edge: --> --- -.-> ==> --x --o <-->, with an optional |label|.
const EDGE = /\s*<?(?:-{2,}|={2,}|-\.+-?)(?:>|x|o)?\s*(?:\|([^|]*)\|)?\s*/;

export function parseFlowchart(src) {
  const lines = src.split(/\n|;/).map((l) => l.trim());
  const head = /^(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)?/i.exec(lines.find((l) => l && !l.startsWith('%%')) ?? '');
  const dir = (head?.[1] ?? 'TD').toUpperCase();
  const nodes = new Map(); // id → label
  const edges = []; // { from, to, label }
  const add = (n) => {
    if (!n) return;
    if (!nodes.has(n.id) || n.label !== null) nodes.set(n.id, n.label ?? nodes.get(n.id) ?? n.id);
  };
  for (const raw of lines.slice(1)) {
    if (!raw || /^(%%|classDef|class |style |linkStyle|click |subgraph\b|end\b|direction\b)/.test(raw)) continue;
    // “A -- text --> B” is the same edge as “A -->|text| B”.
    const line = raw.replace(/(-{2}|={2}|-\.)\s+([^-=.>|][^>|]*?)\s+(-->|==>|\.->|---)/g, (_m, _a, text, arrow) => `${arrow}|${text}|`);
    const parts = line.split(new RegExp(EDGE.source)); // [nodes, label, nodes, label, nodes…]
    const groups = [];
    for (let i = 0; i < parts.length; i += 2)
      groups.push(
        (parts[i] ?? '')
          .split(/\s*&\s*/)
          .map(parseNode)
          .filter(Boolean),
      );
    for (const g of groups) for (const n of g) add(n);
    for (let i = 0; i + 1 < groups.length; i++)
      for (const a of groups[i]) for (const b of groups[i + 1]) edges.push({ from: a.id, to: b.id, label: parts[2 * i + 1] ? clean(parts[2 * i + 1]) : '' });
  }
  return { dir, nodes, edges };
}

/**
 * Ranks by longest path from the sources, with back edges (cycles) left out.
 * @param {Map<string, string>} nodes @param {{ from: string, to: string, label: string }[]} edges
 * @returns {Map<string, number>}
 */
function ranks(nodes, edges) {
  /** @type {Map<string, { from: string, to: string, label: string }[]>} */
  const out = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const e of edges) out.get(e.from)?.push(e);
  const state = new Map();
  /** @type {{ from: string, to: string, label: string }[]} */
  const forward = [];
  const visit = (id) => {
    state.set(id, 1);
    for (const e of out.get(id) ?? []) {
      const s = state.get(e.to);
      if (s === 1) continue; // a back edge: part of a loop
      forward.push(e);
      if (!s) visit(e.to);
    }
    state.set(id, 2);
  };
  for (const id of nodes.keys()) if (!state.get(id)) visit(id);
  /** @type {Map<string, number>} */
  const rank = new Map([...nodes.keys()].map((id) => [id, 0]));
  const at = (id) => rank.get(id) ?? 0;
  // Longest path: relax until stable (the forward edges form a DAG, so this ends).
  for (let pass = 0, changed = true; changed && pass <= nodes.size; pass++) {
    changed = false;
    for (const e of forward)
      if (at(e.to) < at(e.from) + 1) {
        rank.set(e.to, at(e.from) + 1);
        changed = true;
      }
  }
  return rank;
}

function flowchartWidth({ dir, nodes, edges }) {
  const rank = ranks(nodes, edges);
  const byRank = new Map();
  for (const [id, r] of rank) (byRank.get(r) ?? byRank.set(r, []).get(r)).push(id);
  const levels = [...byRank.keys()].sort((a, b) => a - b).map((r) => byRank.get(r));
  const width = (id) => boxWidth(nodes.get(id));
  if (dir === 'LR' || dir === 'RL') {
    // Side by side: each rank is as wide as its widest box, and labeled edges widen the gap after it.
    let w = 16;
    levels.forEach((ids, i) => {
      w += Math.max(...ids.map(width));
      if (i < levels.length - 1) {
        const lab = Math.max(0, ...edges.filter((e) => ids.includes(e.from) && rank.get(e.to) === (rank.get(e.from) ?? 0) + 1).map((e) => labelWidth(e.label)));
        w += lab ? lab + 30 : RANK_GAP;
      }
    });
    return { width: w, sideBySide: levels.length, widest: Math.max(...levels.map((l) => l.length)) };
  }
  // Top to bottom: the widest rank sets the width.
  const w = 16 + Math.max(...levels.map((ids) => ids.reduce((a, id) => a + width(id), 0) + (ids.length - 1) * NODE_GAP));
  return { width: w, sideBySide: Math.max(...levels.map((l) => l.length)), widest: Math.max(...levels.map((l) => l.length)) };
}

// ── Sequence diagrams ──────────────────────────────────────────────────────────────────

export function parseSequence(src) {
  const participants = new Map(); // id → label
  const messages = [];
  for (const raw of src.split('\n').slice(1)) {
    const line = raw.trim();
    let m = /^(?:participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/.exec(line);
    if (m) {
      participants.set(m[1], m[2] ?? m[1]);
      continue;
    }
    m = /^([^-+>\s:]+)\s*(?:-{1,2}>>|-{1,2}>|-{1,2}x|-{1,2}\)|<<-{1,2}>>)\s*[+-]?\s*([^:\s]+)\s*:\s*(.*)$/.exec(line);
    if (m) {
      for (const p of [m[1], m[2]]) if (!participants.has(p)) participants.set(p, p);
      messages.push({ from: m[1], to: m[2], text: m[3] });
    }
  }
  return { participants, messages };
}

function sequenceWidth({ participants, messages }) {
  const ids = [...participants.keys()];
  const box = (id) => Math.max(150, boxWidth(participants.get(id)));
  let w = 0;
  ids.forEach((id, i) => {
    w += box(id);
    if (i < ids.length - 1) {
      // A message between neighbors pushes them apart to fit its text.
      const text = Math.max(
        0,
        ...messages.filter((m) => [m.from, m.to].includes(id) && [m.from, m.to].includes(ids[i + 1])).map((m) => longestLine(m.text) * CHAR_PX),
      );
      w += Math.max(80, text - 70);
    }
  });
  return { width: w + 20, sideBySide: ids.length, widest: ids.length };
}

// ── The check ──────────────────────────────────────────────────────────────────────────

/**
 * Checks one Mermaid diagram. Problems come back as sentences that say what to change.
 * @param {string} src
 * @param {{ width?: number }} [opts]  the width it’s shown at
 * @returns {{ kind: string, textPx: number|null, problems: { code: string, message: string }[] }}
 */
export function lintDiagram(src, { width = COLUMN_PX } = {}) {
  const first = src.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%')) ?? '';
  const kind = /^\s*(flowchart|graph)\b/i.test(first) ? 'flowchart' : (/^\s*([A-Za-z-]+)/.exec(first)?.[1] ?? 'diagram');
  const problems = [];
  /** @type {number|null} */
  let textPx = null;
  const tooSmall = (layout, cause) => {
    const px = Math.round(DIAGRAM_TEXT_PX * Math.min(1, width / layout.width) * 10) / 10;
    textPx = px;
    if (px < MIN_TEXT_PX)
      problems.push({
        code: 'text-too-small',
        message: `It would be drawn about ${Math.round(layout.width)} px wide, so at the conversation’s width (${width} px) its text shrinks to about ${Math.round(px)} px, too small to read. ${cause}`,
      });
  };
  if (kind === 'flowchart') {
    const g = parseFlowchart(src);
    const layout = flowchartWidth(g);
    const across = g.dir === 'LR' || g.dir === 'RL';
    const longest = Math.max(0, ...[...g.nodes.values()].map(longestLine));
    const causes = [
      across && layout.sideBySide > 5
        ? `Its longest chain has ${layout.sideBySide} steps side by side; draw it top to bottom (flowchart TD), or split it.`
        : '',
      !across && layout.widest > 4
        ? `One row has ${layout.widest} boxes side by side; stack them, group them in a subgraph, or move the list into the reply as text.`
        : '',
      longest > 28 ? `Its longest label has ${longest} characters; keep labels to a few words and put the detail in the reply.` : '',
    ].filter(Boolean);
    tooSmall(layout, causes.join(' ') || 'Split it into smaller diagrams, or draw it top to bottom.');
    if (g.nodes.size > MAX_PARTS)
      problems.push({
        code: 'too-many-parts',
        message: `It has ${g.nodes.size} boxes, more than about ${MAX_PARTS} can be followed at once. Split it into an overview and a diagram per part.`,
      });
    if (layout.widest > MAX_SIDE_BY_SIDE && !problems.some((p) => p.code === 'text-too-small'))
      problems.push({
        code: 'long-list',
        message: `It puts ${layout.widest} boxes in one row. A long list reads better as a list in the reply, or grouped into a few boxes.`,
      });
  } else if (kind === 'sequenceDiagram') {
    const seq = parseSequence(src);
    tooSmall(
      sequenceWidth(seq),
      seq.participants.size > 4
        ? `It has ${seq.participants.size} participants side by side; keep to four or five, or split the exchange.`
        : 'Shorten the message text.',
    );
    if (seq.participants.size > MAX_PARTICIPANTS && !problems.length)
      problems.push({
        code: 'too-many-parts',
        message: `It has ${seq.participants.size} participants. More than ${MAX_PARTICIPANTS} can’t be followed at once; split it.`,
      });
    if (seq.messages.length > MAX_MESSAGES)
      problems.push({ code: 'too-long', message: `It has ${seq.messages.length} messages. Split it into phases of fewer than ${MAX_MESSAGES}.` });
  } else {
    const statements = src.split('\n').filter((l) => l.trim() && !l.trim().startsWith('%%')).length - 1;
    if (statements > MAX_PARTS * 1.5)
      problems.push({
        code: 'too-many-parts',
        message: `It has ${statements} lines of definitions, more than can be followed at once. Split it into smaller diagrams.`,
      });
  }
  return { kind, textPx, problems };
}

/** The diagrams in a reply that people won’t be able to read: [{ index, kind, problems, excerpt, src }]. */
export function lintDiagrams(markdown, opts) {
  return mermaidBlocks(markdown)
    .map(({ index, src }) => ({ index, src, ...lintDiagram(src, opts) }))
    .filter((d) => d.problems.length)
    .map(({ index, src, kind, problems }) => ({ index, kind, problems, excerpt: src.split('\n').slice(0, 3).join('\n'), src }));
}
