// Diagram checks from the page: the diagram linter estimates from a diagram’s source when a turn ends; the browser
// measures the real text size after it renders, or sees Mermaid fail, and reports here what the estimate missed.
// Either way the agent hears about a diagram once, by its hash on the session. Moved out of server/runtime.mjs;
// Runtime keeps a method of the same name that delegates here.

import { createHash } from 'node:crypto';
import { COLUMN_PX, MIN_TEXT_PX, mermaidBlocks } from '../shared/diagram-lint.mjs';
import { clipText } from './helpers.mjs';

export function rememberDiagrams(rt, sessionId, sources) {
  const se = rt.s.sessions[sessionId];
  if (!se) return;
  const hashes = sources.map((s) => createHash('sha256').update(s.trim()).digest('hex').slice(0, 16));
  rt.updateSession(sessionId, { diagramsLinted: [...new Set([...(se.diagramsLinted ?? []), ...hashes])].slice(-50) });
}

/**
 * The browser drew a diagram: { src, textPx, width } when it measured it, or { src, error: { message, line } }
 * when Mermaid couldn’t draw it.
 */
export function diagramCheck(rt, threadId, itemId, { src, textPx, width, error }) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'agent' || it.lintReply || typeof src !== 'string') return { ok: true, sent: false };
  const se = rt.s.sessions[it.sessionId];
  const failed = error && typeof error === 'object' && typeof error.message === 'string';
  // Only a measurement at the conversation’s width counts; a narrow panel or phone shrinks every diagram.
  if (!se || (!failed && (!(textPx < MIN_TEXT_PX) || !(width >= COLUMN_PX * 0.8)))) return { ok: true, sent: false };
  const hash = createHash('sha256').update(src.trim()).digest('hex').slice(0, 16);
  if (se.diagramsLinted?.includes(hash)) return { ok: true, sent: false };
  // Only a diagram the reply has: its position and first lines come from the reply, not from the browser.
  const block = mermaidBlocks(String(it.text)).find((b) => b.src.trim() === src.trim());
  if (!block) return { ok: true, sent: false };
  const excerpt = block.src
    .split('\n')
    .slice(0, 3)
    .map((l) => clipText(l, 120))
    .join('\n');
  const scope = { kind: 'diagram', index: block.index, excerpt };
  let problem;
  if (failed) {
    // Mermaid’s message, without its caret line: “Parse error on line 2: … Expecting 'SEMI', got 'ARROW'”.
    const said = error.message
      .split('\n')
      .filter((l) => l.trim() && !/^[-\s]*\^$/.test(l))
      .join(' ')
      .slice(0, 400);
    const line = Number.isInteger(error.line) && error.line > 0 ? ` (line ${Math.min(error.line, 9999)})` : '';
    problem = {
      code: 'diagram-error',
      message: `Mermaid couldn’t draw it, so the person sees an error and its source instead. Mermaid said${line}: “${said}”. Fix the syntax.`,
      scope,
    };
  } else
    problem = {
      code: 'text-too-small',
      message: `In the person’s browser, its text is drawn at ${Math.round(textPx * 10) / 10} px at a width of ${Math.round(width)} px, too small to read. Draw it top to bottom, split it, or shorten its labels.`,
      scope,
    };
  const sent = rt.lint(se.id, it.turnId, [problem]);
  if (sent) rememberDiagrams(rt, se.id, [src]);
  return { ok: true, sent };
}
