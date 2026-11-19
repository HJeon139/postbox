// A reply’s tool calls and thoughts as ATIF tool_calls, observation and reasoning_content (tools/atif.mjs). The tool’s
// name is the one its harness gave, which each step records (`tool`, server/harness-tools.mjs). Structured arguments
// come from the work ledger, which keeps them for a command (its command line), a call to another MCP server (its
// input) and a read (its target), by the call’s id; any other call’s arguments are left empty, and its step’s
// display text goes in extra, marked as such, never in place of them. A recording from before steps kept their tool
// names says function_name “unknown”, and extra says it wasn’t recorded.

import { READ_TOOLS } from '../shared/work.mjs';

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

/** How a call’s arguments were found, for its extra. @param {any} w @param {any} args */
const argumentsSource = (w, args) => {
  if (!args) return 'not recorded';
  return w.kind === 'read' ? 'work ledger, target as displayed' : 'work ledger';
};

/**
 * The tool calls, their results and the thoughts of one reply.
 * @param {any} it  the reply, with its steps @param {Map<string, any>} ledger  the work ledger’s calls, by tool call id
 */
export function callsOf(it, ledger) {
  const steps = [...it.steps.values()].filter((s) => s.label && s.kind !== 'reply');
  const thoughts = steps.filter((s) => s.kind === 'thought').map((s) => s.detail ?? s.label);
  const calls = steps.filter((s) => s.kind !== 'thought');
  const tool_calls = calls.map((s) => {
    const w = ledger.get(s.id);
    const name = typeof s.tool === 'string' && s.tool ? s.tool : ledgerName(w);
    const args = ledgerArguments(w);
    return {
      tool_call_id: s.id,
      function_name: name ?? 'unknown',
      arguments: args ?? {},
      extra: {
        label: s.label,
        state: s.state ?? null,
        ...(typeof s.ms === 'number' ? { ms: s.ms } : {}),
        ...(s.kind ? { kind: s.kind } : {}),
        ...(name ? {} : { function_name: 'not recorded' }),
        arguments_source: argumentsSource(w, args),
        // What the conversation showed of its input, cut: only live frames carry it.
        ...(typeof s.input === 'string' ? { display_input: s.input } : {}),
      },
    };
  });
  const results = calls
    .filter((s) => typeof s.output === 'string' || typeof s.detail === 'string')
    .map((s) => ({ source_call_id: s.id, content: s.output ?? s.detail }));
  return { tool_calls, results, thoughts };
}
