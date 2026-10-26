// An agent whose turns run on a host (#120), in the agents list and the agent’s panel (app/js/agents.mjs): the
// host, the connection in words and why Postbox can’t reach it, a turn there that needs saying, and the line that
// ages as the minutes pass. Codex’s default model reads as one choice, `auto`, whatever older setting stands for it.

import { codexDefault, modelName } from '/shared/agent-facts.mjs';
import { h } from './dom.mjs';
import { hostLine, hostOf, turnLine } from './remote.mjs';
import { modelsFor } from './sheets.mjs';

/**
 * Repaints a minute apart while el is on the page, since “last heard from 2 min ago” ages while nothing changes.
 * @param {HTMLElement} el @param {() => void} paint @param {() => void} off  what else destroy undoes
 * @returns {() => void} destroy: stops listening, and the clock
 */
export function everyMinute(el, paint, off) {
  const tick = setInterval(() => el.isConnected && paint(), 60_000);
  return () => {
    off();
    clearInterval(tick);
  };
}

/**
 * Where it runs, in the agent’s panel, when that’s a host: the connection in words, the turn there when it needs
 * saying, and why Postbox can’t reach the host. Null for an agent on this computer.
 * @param {any} se
 */
export function hostSection(se) {
  const host = hostOf(se);
  if (!host) return null;
  const there = turnLine(se);
  const failure = host.status?.failure;
  return h(
    'section.qp-sec.qp-host',
    { 'aria-label': `Where @${se.handle} runs` },
    h('p.small', hostLine(se)),
    there ? h('p.small', there) : null,
    failure?.message ? h('p.small.dim', failure.message, failure.next ? ` ${failure.next}` : '') : null,
  );
}

/**
 * The panel’s model choices and the one chosen: Codex’s default is one choice, `auto`, whatever older setting stands
 * for it. @param {any} f  the agent’s facts (agent-facts.mjs, factsOf) @returns {[[string, string][], string]}
 */
export function modelOptions(f) {
  const value = codexDefault(f.backend, f.setModel) ? 'auto' : f.setModel;
  const list = [...new Set([...modelsFor(f.backend), value])]
    .filter((m) => !(f.backend === 'codex' && m !== 'auto' && codexDefault(f.backend, m)))
    .map((m) => /** @type {[string, string]} */ ([m, modelName(f.backend, m)]));
  return [list, value];
}
