/** The persona’s permission mode as agy’s flags (#370: --dangerously-skip-permissions only once the PreToolUse hook is confirmed). */
export function modeArgs(persona, { hookConfirmed = false } = {}) {
  if (hookConfirmed) return ['--dangerously-skip-permissions'];
  switch (persona?.permissionMode) {
    case 'auto':
      return ['--mode', 'auto'];
    case 'acceptEdits':
      return ['--mode', 'accept-edits'];
    case 'bypass':
      return ['--dangerously-skip-permissions'];
    default:
      return [];
  }
}

/**
 * The CLI arguments for one turn. Pure, so the tests can check them. Every flag comes before the message: given
 * as --print=<message>, it is one argument whatever it starts with.
 * @param {{ persona: any, model: string, effort: string|null, sessionId?: string|null, prompt: string, addDirs?: string[], hookConfirmed?: boolean }} turn
 */
export function agyArgs({ persona, model, effort, sessionId = null, prompt, addDirs = [], hookConfirmed = false }) {
  return [
    // Both always passed, where agy takes them: left out, your agy settings would decide (#60).
    '--model',
    model,
    ...(effort ? ['--effort', effort] : []),
    ...(sessionId ? ['--conversation', sessionId] : []),
    ...modeArgs(persona, { hookConfirmed }),
    // A message that starts with / is the person’s text, not one of agy’s commands.
    '--disable-slash-commands',
    '--output-format',
    'stream-json',
    ...addDirs.flatMap((d) => ['--add-dir', d]),
    `--print=${prompt}`,
  ];
}
