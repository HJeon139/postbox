// A turn’s activity list under its reply: the summary line and the tree of steps, with what each subagent did nested
// under the step that started it (#73).

import { h, plural } from './dom.mjs';

export function activityLabel(all) {
  const steps = all.filter((s) => s.kind !== 'thought' && s.kind !== 'said');
  const thoughts = all.filter((s) => s.kind === 'thought').length;
  const refused = steps.filter((s) => s.state === 'denied').length;
  const reads = steps.filter((s) => /^(read|grep|arxiv\.fetch|corpus\.read)/.test(s.label)).length;
  const verb = steps.some((s) => s.label.startsWith('grep')) ? 'Searched' : 'Read';
  const used = !steps.length
    ? null
    : reads === steps.length
      ? `${verb} ${plural(steps.length, steps.some((s) => s.label.startsWith('arxiv')) ? 'paper' : 'file')}`
      : `Used ${plural(steps.length, 'tool')}`;
  return [used, thoughts ? plural(thoughts, 'thought') : null, refused ? `${refused} refused` : null].filter(Boolean).join(' · ');
}

/**
 * The activity list as a tree (#73): what a subagent did, said and thought nests under the step that started it, at
 * any depth, so a refused or failed step points at the subagent that took it.
 */
export function stepTree(steps) {
  const ids = new Set(steps.map((s) => s.id));
  /** @type {Map<string, any[]>} */
  const kids = new Map();
  for (const s of steps) if (s.parent && s.parent !== s.id && ids.has(s.parent)) kids.set(s.parent, [...(kids.get(s.parent) ?? []), s]);
  const seen = new Set();
  const row = (s) => {
    seen.add(s);
    const li = stepRow(s);
    const under = (kids.get(s.id) ?? []).filter((x) => !seen.has(x));
    if (under.length) li.append(h('ul.steps', under.map(row)));
    return li;
  };
  const top = steps.filter((s) => !s.parent || s.parent === s.id || !ids.has(s.parent)).map(row);
  // Any a bad parent left out (a loop) is listed at the top, rather than gone.
  for (const s of steps) if (!seen.has(s)) top.push(row(s));
  return h('ul.steps', top);
}

// One step in an agent’s activity list: a tool call (the agent’s or a subagent’s), a thought, or a subagent’s
// narration, which open to their whole text. A failed step says why; a refused one says why too when its backend does
// (the Kiro and Antigravity CLIs refuse headless, with no card: #152), and otherwise points to its card. A subagent’s
// step says what it returned once it has (#73).
const GLYPH = { running: 'running', failed: 'failed', denied: 'failed', done: 'done', stopped: 'stalled' };
function stepRow(s) {
  const dur = h('span.dur', s.ms ? `${(s.ms / 1000).toFixed(1)} s` : '');
  // A subagent’s thought or narration is labeled with its name: it’s its own, never the agent’s (#73).
  const who = s.who ? h('span.step-who', `${s.who}:`) : null;
  if (s.kind === 'thought' || s.kind === 'said')
    return h(
      `li.${s.kind}`,
      // Narration is read as “name: what it said”, so its glyph isn’t read too.
      s.kind === 'said' ? h('span.g.g-said', { 'aria-hidden': 'true' }) : h('span.g.g-thought', { role: 'img', 'aria-label': 'thought' }),
      s.detail && s.detail !== s.label
        ? h('details.step-text', h('summary', who ? [who, ' '] : null, s.label), h('p', s.detail))
        : h('span.step-text', who ? [who, ' '] : null, h('span', s.label)),
      dur,
    );
  const note =
    s.state === 'denied'
      ? s.detail || 'Refused: see the card below.'
      : s.state === 'failed'
        ? s.detail
        : s.state === 'stopped'
          ? `Stopped${s.detail ? `: ${s.detail}` : ''}`
          : s.job && s.state === 'running'
            ? s.detail || 'Running in the background'
            : s.kind === 'agent'
              ? s.detail || null
              : null;
  return h(
    'li',
    { class: s.state === 'denied' ? 'denied' : '' },
    h(`span.g.g-${GLYPH[s.state] ?? 'done'}`, { role: 'img', 'aria-label': s.state === 'denied' ? 'refused' : s.state }),
    h('span.step-text', s.who ? h('span.step-who', `${s.who} ·`) : null, h('span.mono', s.label), note ? h('span.step-note', note) : null),
    dur,
  );
}
