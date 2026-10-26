// What Postbox tells an Antigravity agent, and the person, about the calls agy refuses headless when the PreToolUse
// hook isn’t running (server/adapters/antigravity-cli.mjs, “Permissions”).

export const clip = (s, n) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// A live turn (agy 1.4.5) had a command refused as “user denied permission to run command”. Nobody was asked, so
// the agent is told what a refusal means here, and that agy ends the turn at one, before any reply.
export const HEADLESS_NOTE =
  '## Refused tool calls\n\nPostbox runs you headless, so Antigravity can’t ask the person to approve a tool call: one that would need approval is refused, and Antigravity reports it as “user denied permission”. The person didn’t see or decline it. A refusal ends your turn there, before you can reply, so don’t make a call that needs approval when you can do without it. If one is refused, say next turn which call it was and that your permissions in Postbox didn’t allow it.';

// In the Gemini room UAT rerun, an agent looking for a plan ran `ls -la` in its folder twice: refused, and each time
// its turn ended with no reply. agy’s file tools read its folders without asking (every read_file in that run went
// through), so it’s pointed at them. Run everything allows commands, so it isn’t told this.
export const LOOKING_NOTE =
  '## Looking at files\n\nUse list_dir, find_by_name, grep_search and view_file to look at files: in your folders they don’t need approval. Don’t use run_command to look around (ls, find, cat): a command needs approval here, so it’s refused, and your turn ends with nothing said. What another agent wrote or showed in a block is in your history and read_conversation, and read_message { id } gives one item in full: it isn’t on disk.';

// With the PreToolUse hook running (#370), nothing is refused for want of asking: a call agy would ask about shows the
// person a card, and waits for their answer. HEADLESS_NOTE and LOOKING_NOTE told agents every such call was refused, so
// they stopped running commands at all (the Agent research room, 26 October).
export const HOOK_NOTE =
  '## Calls that need approval\n\nA command, a web search or fetch, a tool of another MCP server, or a file outside your folders may ask the person through a card in Postbox, and then your call waits for their answer. If they don’t allow it, the call fails with their reason: carry on without it, and don’t try it another way. To look at files in your folders, list_dir, find_by_name, grep_search and view_file need no approval. What another agent wrote or showed in a block is in your history and read_conversation, and read_message { id } gives one item in full: it isn’t on disk.';

/** What Postbox tells the agent when agy ended its turn at a refused call. */
export const refusalFollowUp = (label) =>
  `[Postbox] Antigravity refused your last call (${clip(label, 120)}) and ended your turn before you replied. Nobody was asked: Postbox runs you headless. In a sentence, tell the person which call was refused, that your permission mode in Postbox didn’t allow it, and that Run everything would, then carry on without it. Don’t try it again another way.`;

// A refused step says what the mode refuses and what would allow it, when agy runs without the PreToolUse hook and an
// account without auto mode runs Auto as Ask me (#370).
const MODE_REFUSES = {
  ask: 'In Ask me, it refuses every edit and command it would ask about.',
  auto: 'In Auto, its safety check refused it, or your account doesn’t offer auto mode, so it ran as Ask me.',
  acceptEdits: 'In Accept edits, it refuses every command it would ask about.',
};
/** @param {string | undefined} mode the persona’s permission mode */
export const refusalOf = (mode = 'auto') =>
  `Antigravity asks before this, and can’t ask you from Postbox, so it was refused. ${MODE_REFUSES[/** @type {keyof typeof MODE_REFUSES} */ (mode)] ?? MODE_REFUSES.auto} Run everything allows it.`;
