// Diagram checks from the page: the diagram linter estimates from a diagram’s source when a turn ends; the browser
// measures the real text size after it renders, or sees Mermaid fail, and reports here what the estimate missed.
// Either way the agent hears about a diagram once, by its hash on the session. Checks (server/check-service.mjs)
// calls each with itself.

import { createHash } from 'node:crypto';
import { COLUMN_PX, MIN_TEXT_PX, mermaidBlocks } from '../shared/diagram-lint.mjs';
import { clipText } from './helpers.mjs';
import { lint } from './lint-delivery.mjs';

/** A diagram’s key in the session’s diagramsLinted. @param {string} src */
const hashOf = (src) => createHash('sha256').update(src.trim()).digest('hex').slice(0, 16);

export function rememberDiagrams(checks, sessionId, sources) {
  const se = checks.store.state.sessions[sessionId];
  if (!se) return;
  const hashes = sources.map(hashOf);
  checks.sessions.update(sessionId, { diagramsLinted: [...new Set([...(se.diagramsLinted ?? []), ...hashes])].slice(-50) });
}

/**
 * The browser drew a diagram: { src, textPx, width } when it measured it, or { src, error: { message, line } }
 * when Mermaid couldn’t draw it.
 */
export function diagramCheck(checks, threadId, itemId, { src, textPx, width, error }) {
  const it = checks.store.item(threadId, itemId);
  if (it?.kind !== 'agent' || it.lintReply || typeof src !== 'string') return { ok: true, sent: false };
  const se = checks.store.state.sessions[it.sessionId];
  const failed = error && typeof error === 'object' && typeof error.message === 'string';
  // Only a measurement at the conversation’s width counts; a narrow panel or phone shrinks every diagram.
  if (!se || (!failed && (!(textPx < MIN_TEXT_PX) || !(width >= COLUMN_PX * 0.8)))) return { ok: true, sent: false };
  if (se.diagramsLinted?.includes(hashOf(src))) return { ok: true, sent: false };
  // Only a diagram the reply has: its position and first lines come from the reply, not from the browser.
  const block = mermaidBlocks(String(it.text)).find((b) => b.src.trim() === src.trim());
  if (!block) return { ok: true, sent: false };
  const scope = scopeOf(block);
  const problem = failed
    ? failedProblem(error, scope)
    : {
        code: 'text-too-small',
        message: `In the person’s browser, its text is drawn at ${Math.round(textPx * 10) / 10} px at a width of ${Math.round(width)} px, too small to read. Draw it top to bottom, split it, or shorten its labels.`,
        scope,
      };
  const sent = lint(checks, se.id, it.turnId, [problem]);
  if (sent) rememberDiagrams(checks, se.id, [src]);
  return { ok: true, sent };
}

/** What a problem about a diagram names: its place in the reply and its first lines. @param {{ index: number, src: string }} block */
function scopeOf(block) {
  const excerpt = block.src
    .split('\n')
    .slice(0, 3)
    .map((l) => clipText(l, 120))
    .join('\n');
  return { kind: 'diagram', index: block.index, excerpt };
}

/** Mermaid couldn’t parse or draw the diagram. @param {{ message: string, line?: number | null }} error @param {any} scope */
function failedProblem(error, scope) {
  // Mermaid’s message, without its caret line: “Parse error on line 2: … Expecting 'SEMI', got 'ARROW'”.
  const said = error.message
    .split('\n')
    .filter((l) => l.trim() && !/^[-\s]*\^$/.test(l))
    .join(' ')
    .slice(0, 400);
  const line = Number.isInteger(error.line) && Number(error.line) > 0 ? ` (line ${Math.min(Number(error.line), 9999)})` : '';
  return {
    code: 'diagram-error',
    message: `Mermaid couldn’t draw it, so the person sees an error and its source instead. Mermaid said${line}: “${said}”. Fix the syntax.`,
    scope,
  };
}
