// A composer line that runs a command (#67): `/name args`, or `@handle /name args`, which aims it at the agent it
// names (#405). Without the @handle it’s for the agent the composer replies to, as before. Postbox’s own commands
// (/compact, /mode, …) act on that agent without a turn; an agent’s skill or command runs as that agent’s turn, with
// `/name args` as the whole prompt, since a CLI runs a slash command only at the start of one.

/**
 * The command a line names, or null for a message. handle: the @handle before it, without the @, or null.
 * @param {string} text @returns {{ handle: string | null, name: string, rest: string, line: string } | null}
 */
export function parseSlashLine(text) {
  const m = String(text ?? '')
    .trim()
    .match(/^(?:@([A-Za-z0-9_-]+)\s+)?\/([\w:.@/-]+)(\s[\s\S]*)?$/);
  if (!m) return null;
  const [, handle = null, name, rest = ''] = m;
  return { handle, name, rest, line: `/${name}${rest}` };
}

/**
 * What a line does when sent, and for whom. own: one of Postbox’s commands, run for se. Otherwise an agent’s skill or
 * command, run as se’s turn with line as the prompt. missing: the line goes as a message, because the agent it names
 * offers no such command ('command'), or because no agent here has that handle ('agent'); the composer says which
 * before it’s sent. Null for a plain message.
 * @param {string} text
 * @param {{ members: any[], reply: any, pick?: (name: string) => any, own: string[], has: (se: any, name: string) => boolean }} at
 *   members: the conversation’s sessions; reply: the one the composer replies to; pick: the agent the / menu chose
 *   for that name, if any; own: Postbox’s command names; has: whether an agent offers a skill or command of that name
 * @returns {{ own: boolean, name: string, line: string, se: any, named: any } | { missing: 'command' | 'agent', name: string, named: any, handle: string | null } | null}
 */
export function resolveCommand(text, { members, reply, pick = () => null, own, has }) {
  const cmd = parseSlashLine(text);
  if (!cmd) return null;
  const live = members.filter((x) => !x.archived);
  const named = cmd.handle ? (live.find((x) => x.handle.toLowerCase() === cmd.handle?.toLowerCase()) ?? null) : null;
  // An @handle that isn’t an agent here, as a typo: a message to the agent the composer replies to, said first.
  if (cmd.handle && !named) return { missing: 'agent', name: cmd.name, named: null, handle: cmd.handle };
  if (own.includes(cmd.name) && !cmd.rest.trim()) return { own: true, name: cmd.name, line: cmd.line, se: named ?? reply, named };
  const offers = (se) => !!se && has(se, cmd.name);
  const se = named ? (offers(named) ? named : null) : (pick(cmd.name) ?? (offers(reply) ? reply : null) ?? live.find(offers) ?? null);
  if (se) return { own: false, name: cmd.name, line: cmd.line, se, named };
  return named ? { missing: 'command', name: cmd.name, named, handle: cmd.handle } : null;
}
