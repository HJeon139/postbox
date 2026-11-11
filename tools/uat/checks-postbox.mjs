// The run’s own Postbox must print nothing wrong: no error, no warning, and no exit of its own mid-run. A 500’s
// TypeError reached the person’s terminal on `npm start` while every UAT run copied the same kind of line into its
// log unread. The check reads what tools/uat/postbox-output.mjs records, and any finding fails the run: the runner
// exits non-zero (tools/uat-run.mjs), so a script or session running UAT sees it without reading the report.

import { clip } from '../../shared/text.mjs';

export const POSTBOX_OUTPUT = 'postbox-output';

// What a clean start prints, on stdout: its banner (server/index.mjs). Every UAT run’s log up to 8 Nov held only these.
const BANNER = /^(?:Postbox is running at |Data: |Backends: |On hosts only: |Demo controls are on\.$)/;
// Error output: a stack frame, a thrown error’s name (TypeError: …, Error: …), or Node’s words for what nothing caught.
const STACK = /^\s+at \S/;
const ERROR = /\b\w*(?:Error|Exception)\b:|\bUnhandled\b|\buncaught\b/i;
// Warnings: Node’s own, “(node:123) [DEP0040] DeprecationWarning: …”, and any line that says warn.
const WARNING = /^\(node:\d+\) |\b(?:Deprecation|Experimental)Warning\b|warn/i;
// Lines that go on a problem above them: its stack, an error’s fields, Node’s hint and version, a source line’s caret.
const MORE = /^\s|^\}$|^\(Use `node --trace-|^Node\.js v\d|^\^+$/;

const TITLES = {
  error: 'Postbox printed an error',
  warning: 'Postbox printed a warning',
  stderr: 'Postbox wrote to its error output',
};

/** What kind of problem a line starts, or null for a line that’s fine. @param {import('./postbox-output.mjs').OutputLine} l */
function kindOf(l) {
  if (l.stream === 'stdout' && BANNER.test(l.text)) return null;
  if (WARNING.test(l.text)) return 'warning';
  if (STACK.test(l.text) || ERROR.test(l.text)) return 'error';
  return l.stream === 'stderr' ? 'stderr' : null;
}

/**
 * The output’s problems, each with its lines: a stack trace, an error’s fields and Node’s hint go with the line above
 * them, and the file and caret Node prints above an uncaught error go with that error.
 * @param {import('./postbox-output.mjs').OutputLine[]} lines
 */
export function outputProblems(lines) {
  /** @type {{ kind: string, stream: string, step: number | null, lines: string[] }[]} */
  const problems = [];
  let open = null;
  for (const l of lines) {
    if (!l.text.trim()) continue;
    if (open && open.stream === l.stream && MORE.test(l.text)) {
      open.lines.push(l.text);
      continue;
    }
    const kind = kindOf(l);
    if (kind === 'error' && open?.kind === 'stderr' && open.stream === l.stream) {
      open.kind = 'error';
      open.lines.push(l.text);
      continue;
    }
    open = kind ? { kind, stream: l.stream, step: l.step, lines: [l.text] } : null;
    if (open) problems.push(open);
  }
  return problems;
}

/** Where it happened, in the report’s words. @param {number | null} step */
const atStep = (step) => (step ? `at step ${step}` : 'before the first step');

/**
 * One finding for each distinct problem: the same line printed again, with only its numbers changed, is the same
 * problem, counted. A crash is one finding for each exit.
 * @param {{ postboxOutput?: import('./postbox-output.mjs').PostboxOutput }} f
 */
function postboxOutput(f) {
  const out = f.postboxOutput ?? { lines: [], exits: [] };
  /** @type {Map<string, { kind: string, first: ReturnType<typeof outputProblems>[number], times: number, last: number | null }>} */
  const seen = new Map();
  for (const p of outputProblems(out.lines)) {
    const key = `${p.kind}:${clip(p.lines[0].replace(/\d+/g, 'N'), 120)}`;
    const s = seen.get(key);
    if (s) Object.assign(s, { times: s.times + 1, last: p.step });
    else seen.set(key, { kind: p.kind, first: p, times: 1, last: p.step });
  }
  const printed = [...seen].map(([key, s]) => ({
    key: `${POSTBOX_OUTPUT}:${key}`,
    severity: 'critical',
    title: TITLES[/** @type {keyof typeof TITLES} */ (s.kind)],
    evidence: `${atStep(s.first.step)}${s.times > 1 ? ` and ${s.times - 1} more time(s), the last ${atStep(s.last)}` : ''}, on ${s.first.stream}: ${s.first.lines
      .slice(0, 8)
      .map((t) => clip(t.trim(), 200))
      .join(' ⏎ ')}`,
  }));
  const crashes = out.exits.map((x, i) => ({
    key: `${POSTBOX_OUTPUT}:exit:${i + 1}`,
    severity: 'critical',
    title: 'Postbox exited by itself mid-run',
    evidence: `It exited ${atStep(x.step)}, ${x.signal ? `on ${x.signal}` : `with code ${x.code}`}, when the run hadn’t stopped it.`,
  }));
  return [...printed, ...crashes];
}

export const POSTBOX_OUTPUT_CHECKS = [{ id: POSTBOX_OUTPUT, inputs: ['postboxOutput'], issue: null, run: postboxOutput }];

/** Whether a run’s findings fail it: any of this check’s does. @param {{ check?: string }[]} findings */
export const failsRun = (findings) => findings.some((f) => f.check === POSTBOX_OUTPUT);
