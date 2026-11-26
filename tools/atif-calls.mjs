// A reply’s tool calls and thoughts as ATIF tool_calls, observation and reasoning_content (tools/atif.mjs). The tool’s
// name is the one its harness gave, which each step records (`tool`, server/harness-tools.mjs). Structured arguments
// come from the work ledger, which keeps them for a command (its command line), a call to another MCP server (its
// input) and a read (its target), by the call’s id; an AskUserQuestion’s from the question blocks it showed, which
// Postbox made from its input (server/ask-question.mjs); any other call’s arguments are left empty, and its step’s
// display text goes in extra, marked as such, never in place of them. A recording from before steps kept their tool
// names says function_name “unknown”, and extra says it wasn’t recorded. A subagent’s own words (a `said` step,
// server/harness-text.mjs) are no call: they’re the reply’s narration, in its extra.

import { READ_TOOLS } from '../shared/work.mjs';
import { iso } from './atif-time.mjs';

/** The most of one call's output a result carries, in characters: a longer one is cut, and says so. */
export const RESULT_CHARS = 16_384;

/** The largest stored output read for a result, in bytes: a bigger blob isn't read whole just to keep its start. */
export const RESULT_READ_BYTES = 64 * 1024 * 1024;

/** An output as a result's content, cut at RESULT_CHARS. @param {string} text */
const resultContent = (text) =>
  text.length > RESULT_CHARS
    ? `${text.slice(0, RESULT_CHARS)}\n[cut by the exporter: ${RESULT_CHARS.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters]`
    : text;

/** The work ledger’s entries for one call that keep its arguments: a command, an external MCP call and a read. */
export const CALL_KINDS = new Set(['command', 'external', 'read']);

/** The work ledger’s entries a run keeps (tools/uat/room-events.mjs) and the trajectories read: turns, and those calls. */
export const WORK_KINDS = new Set(['turn', ...CALL_KINDS]);

/** The tool a ledger entry ran, by its harness’s name, or null. @param {any} w */
function ledgerName(w) {
  if (w?.kind === 'command') return 'Bash';
  if (w?.kind === 'external') return `mcp__${w.server}__${w.tool}`;
  if (w?.kind === 'read') return w.tool;
  return null;
}

/** A call’s arguments as the ledger kept them, or null when it kept none. @param {any} w */
function ledgerArguments(w) {
  if (w?.kind === 'command') return { command: w.command, ...(w.description ? { description: w.description } : {}), run_in_background: w.background === true };
  if (w?.kind === 'external') {
    try {
      const input = JSON.parse(w.input);
      return input && typeof input === 'object' && !Array.isArray(input) ? input : null;
    } catch {
      return null; // the ledger cuts a long input at 4,000 characters, so it may not parse: then none is given
    }
  }
  // A read keeps its target as the conversation shows it: a path relative to the project, not the one the tool got.
  if (w?.kind === 'read' && Object.hasOwn(READ_TOOLS, w.tool)) return { [READ_TOOLS[w.tool]]: w.what };
  return null;
}

/**
 * An AskUserQuestion’s input as its blocks show it, or null with none: each block is one question, made from its
 * `header`, `question`, options’ `label` and `description`, and `multiSelect` (server/ask-question.mjs, choiceOf). A
 * question after one the person dismissed was never shown, so it isn’t here. @param {any[] | undefined} blocks
 */
function questionArguments(blocks) {
  if (!blocks?.length) return null;
  const questions = blocks.map(({ block: b }) => ({
    question: b.prompt,
    ...(b.title ? { header: b.title } : {}),
    options: (b.options ?? []).map((/** @type {any} */ o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    multiSelect: b.multiple === true,
  }));
  return { questions };
}

/** How a call’s arguments were found, for its extra. @param {any} w @param {any} args @param {boolean} asked */
const argumentsSource = (w, args, asked) => {
  if (!args) return 'not recorded';
  if (asked) return 'question blocks';
  return w.kind === 'read' ? 'work ledger, target as displayed' : 'work ledger';
};

/** What a step showed of a call's output, cut: its output's last 400 characters, else its note. @param {any} s */
const shown = (s) => s.output ?? s.detail;

/**
 * A call's output as its result, from the store's blob its ledger entry names (`output.sha256`), or a note of its size
 * when it's too large to read; null when the entry names none or the blob doesn't read back. It wins over what a step
 * showed, which is cut to its last 400 characters (#1757). The blob is the command's stdout and stderr joined, its
 * exit code apart (`exit`); one the ledger kept only the end of says so. A background command's is the output its
 * call ended with (`callOutput`, tools/atif.mjs): when its job ends the ledger may replace its output with the job's,
 * which the agent saw later, not at this call.
 * @param {any} w  the call's ledger entry @param {(sha256: string) => string | null} blob
 */
function storedResult(w, blob) {
  const out = w?.endedInBackground ? w.callOutput : w?.output;
  if (typeof out?.size === 'number' && out.size > RESULT_READ_BYTES) return `[output too large to read: ${out.size.toLocaleString('en-US')} bytes]`;
  const text = typeof out?.sha256 === 'string' ? blob(out.sha256) : null;
  if (typeof text !== 'string') return null;
  const kept = out.cut ? `[the work ledger kept only its last ${out.size.toLocaleString('en-US')} bytes]\n` : '';
  return resultContent(kept + text);
}

/**
 * The tool calls, their results, the thoughts and the narration of one reply. A call's start time and exit code are its
 * ledger entry's; its output is the store's blob the ledger names, else what a live frame showed (storedResult).
 * @param {any} it  the reply, with its steps @param {Map<string, any>} ledger  the work ledger’s calls, by tool call id
 * @param {Map<string, any[]>} [questions]  each AskUserQuestion call’s blocks, by its id
 * @param {(sha256: string) => string | null} [blob]  a stored blob's text, or null when it isn't there
 */
export function callsOf(it, ledger, questions = new Map(), blob = () => null) {
  const steps = [...it.steps.values()].filter((s) => s.label && s.kind !== 'reply');
  const thoughts = steps.filter((s) => s.kind === 'thought').map((s) => s.detail ?? s.label);
  const narration = steps.filter((s) => s.kind === 'said').map((s) => ({ step_id: s.id, text: s.detail ?? s.label, ...(s.who ? { who: s.who } : {}) }));
  const calls = steps.filter((s) => s.kind !== 'thought' && s.kind !== 'said');
  const tool_calls = calls.map((s) => {
    const w = ledger.get(s.id);
    const name = typeof s.tool === 'string' && s.tool ? s.tool : ledgerName(w);
    const asked = !w && questions.has(s.id);
    const args = asked ? questionArguments(questions.get(s.id)) : ledgerArguments(w);
    return {
      tool_call_id: s.id,
      function_name: name ?? 'unknown',
      arguments: args ?? {},
      extra: {
        label: s.label,
        state: s.state ?? null,
        ...(typeof s.ms === 'number' ? { ms: s.ms } : {}),
        ...(iso(w?.at) ? { started_at: iso(w.at) } : {}),
        ...(typeof w?.exit === 'number' ? { exit: w.exit } : {}),
        ...(s.kind ? { kind: s.kind } : {}),
        ...(name ? {} : { function_name: 'not recorded' }),
        arguments_source: argumentsSource(w, args, asked),
        // What the conversation showed of its input and output, cut, and its step's note (a failure's reason, a
        // subagent's summary, a status): only live frames carry the first two.
        ...(typeof s.input === 'string' ? { display_input: s.input } : {}),
        ...(typeof s.output === 'string' ? { display_output: s.output } : {}),
        ...(typeof s.detail === 'string' ? { display_detail: s.detail } : {}),
        ...(w?.endedInBackground ? { ended_in_background: true } : {}),
      },
    };
  });
  const results = calls.flatMap((s) => {
    const content = storedResult(ledger.get(s.id), blob) ?? shown(s);
    return typeof content === 'string' ? [{ source_call_id: s.id, content }] : [];
  });
  return { tool_calls, results, thoughts, narration };
}

/**
 * The question blocks each of a session’s AskUserQuestion calls showed, by the call’s id, in the order they were asked:
 * only calls one of its replies holds, so a block whose call the recording lacks is still a step.
 * @param {{ items: Map<string, any>, order: { id: string }[] }} f @param {string} sessionId @returns {Map<string, any[]>}
 */
export function questionsOf(f, sessionId) {
  const mine = [...f.items.values()].filter((it) => it.sessionId === sessionId);
  const callIds = new Set(mine.filter((it) => it.kind === 'agent').flatMap((it) => [...it.steps.keys()]));
  /** @type {Map<string, any[]>} */
  const out = new Map();
  for (const { id } of f.order) {
    const it = f.items.get(id);
    if (it?.sessionId !== sessionId || it.kind !== 'block' || it.question !== true || !callIds.has(it.toolUseId)) continue;
    out.set(it.toolUseId, [...(out.get(it.toolUseId) ?? []), it]);
  }
  return out;
}
