// What Claude Code’s init says, moved out of claude-stream.mjs.

/**
 * An init’s skills and commands (#67): `slash_commands` lists both, by name, `skills` says which are skills, and
 * `terminal_slash_commands` are bound to a terminal (recorded: doctor, color, focus, reload-plugins), so they’re left
 * out of other surfaces. Recorded in tests/fixtures/claude-code/permission-subagent.jsonl.
 * @param {any} init @returns {{ name: string, skill?: true }[]}
 */
export function commandsOf(init) {
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const terminal = new Set(strings(init?.terminal_slash_commands));
  const skills = new Set(strings(init?.skills));
  return strings(init?.slash_commands)
    .filter((n) => !terminal.has(n))
    .map((name) => (skills.has(name) ? { name, skill: true } : { name }));
}
