// The custom agent Kiro runs for one turn, moved out of kiro-cli.mjs: its prompt notes and its permission rules.

import { realpathSync } from 'node:fs';
import { agentSkills } from './agent-plugin.mjs';
import { SIZE_LIMIT_NOTE } from './kiro-errors.mjs';
import { POSTBOX_SERVER, setupOf } from './setup.mjs';
import { postboxSkillsOn } from './skill-config.mjs';

/**
 * MCP tools that publish outside Postbox, as Kiro’s `server/tool` match patterns, where `*` is any text: the verb
 * rules of PUBLISHING_TOOLS (server/adapters/setup.mjs). Kiro has no claude.ai connectors or built-in publishing
 * tools, so only the verbs carry over. None may match Postbox’s own tools: tests/kiro-cli.test.mjs checks that.
 */
export const KIRO_PUBLISHING = [
  ...['send', 'post', 'reply', 'publish', 'share', 'comment'].flatMap((v) => [`*/${v}`, `*/${v}_*`]),
  ...['send', 'publish'].map((v) => `*/*_${v}_*`),
];

/**
 * The persona’s Tools checklist as Kiro capabilities (kiro.dev/docs/permissions): an id that isn’t ticked denies
 * them. agents.outside has nothing to deny here: Kiro’s subagent tool runs inside the turn, as Claude Code’s Task
 * does, and the chat command has no tool that messages or schedules other sessions.
 */
export const KIRO_TOOL_RULES = /** @type {Record<string, string[]>} */ ({ shell: ['shell'], 'web.fetch': ['web_fetch', 'web_search'] });

/**
 * A folder as given and as resolved: Kiro matches resolved paths (/tmp is /private/tmp on macOS). Resolved natively,
 * as the kernel does: JavaScript’s realpathSync reads a link target’s .. lexically, so a folder linked to sub/../d,
 * with sub a link elsewhere, was allowed as the folder’s lexical sibling d instead (#1215).
 */
const spellings = (dir) => {
  try {
    const real = realpathSync.native(dir);
    return real === dir ? [dir] : [dir, real];
  } catch {
    return [dir];
  }
};

/**
 * The agent’s permission rules. Their order doesn’t matter: in Kiro, deny beats ask beats allow, whatever the scope
 * a rule comes from (kiro.dev/docs/permissions), so a deny here holds against an allow in your own rules.
 * @param {{ persona: any, folders: string[], reads?: string[], resolve?: boolean, kiroHome?: string|null }} turn  folders:
 *   where the agent works, and the folders it may also use; reads: files it may read and nothing more, those attached
 *   to the turn’s message (attached-files.mjs, #1307); resolve: also name each as resolved here (false for a host’s,
 *   which aren’t on this disk); kiroHome: the Kiro home the turn runs with, kept from edits as Kiro’s own (#1723)
 */
export function kiroRules({ persona, folders, reads = [], resolve = true, kiroHome = null }) {
  const { canPublish, usesHostSetup, mcpOff } = setupOf(persona);
  const has = new Set(Array.isArray(persona?.tools) ? persona.tools : []);
  const dirs = [...new Set(folders.filter(Boolean).flatMap(resolve ? spellings : (d) => [d]))];
  const rules = [
    // Postbox’s own tools never need asking: they only show things in the thread.
    { capability: 'mcp', match: [`${POSTBOX_SERVER}/*`], effect: 'allow' },
  ];
  if (dirs.length) rules.push({ capability: 'fs_read', match: dirs, effect: 'allow' });
  // Read only: a headless Kiro can’t ask, so without this the agent couldn’t open what the person attached.
  const files = [...new Set(reads.filter(Boolean).flatMap(resolve ? spellings : (f) => [f]))];
  if (files.length) rules.push({ capability: 'fs_read', match: files, effect: 'allow' });
  const mode = persona?.permissionMode ?? 'auto';
  // In Auto with Shell, any command runs, so a read or an edit follows the shell’s rule anywhere (#1723, as #1710 did
  // for Antigravity): Kiro can’t ask, and refusing a file tool what a command may do only sent the agent to the shell.
  // For file tools Kiro reads `*` within one path segment and `**` across them (kiro.dev/docs/permissions), so it’s
  // `**`. Kiro itself asks before any write in .git, which headless is a refusal, so .git edits stay refused anyway.
  const shellReach = mode === 'auto' && has.has('shell');
  if ((mode === 'acceptEdits' || mode === 'auto') && dirs.length) {
    rules.push({ capability: 'fs_write', match: dirs, effect: 'allow' });
    // An edit there could become a command: Kiro starts the MCP servers a .kiro/settings/mcp.json in the working folder
    // names, and a .git/config can name a program git runs (#136). Kiro matches these case-blind where the disk is, as
    // macOS’s is: kiro-cli 3.1.0 refused .KIRO/settings/mcp.json and .GIT/config there too, recorded live (#136). With
    // Shell in Auto, a command could already write .git, so only .kiro, Kiro’s own, stays denied.
    rules.push({ capability: 'fs_write', match: dirs.flatMap((d) => (shellReach ? [`${d}/.kiro`] : [`${d}/.kiro`, `${d}/.git`])), effect: 'deny' });
  }
  if (shellReach) {
    rules.push({ capability: 'fs_read', match: ['**'], effect: 'allow' }, { capability: 'fs_write', match: ['**'], effect: 'allow' });
    // Kiro’s own home stays as its working folders’ .kiro does: its settings start MCP servers. A command can still
    // write both, so this keeps the file tools honest rather than holding a boundary.
    if (kiroHome) rules.push({ capability: 'fs_write', match: resolve ? spellings(kiroHome) : [kiroHome], effect: 'deny' });
  }
  // Auto runs what the persona’s Tools allow, as #416’s option A: Kiro has no Auto of its own, and nothing judges these
  // calls. The denies below still hold, since Kiro reads deny over allow.
  if (mode === 'auto') rules.push(...autoAllows(has));
  for (const [id, caps] of Object.entries(KIRO_TOOL_RULES))
    if (!has.has(id)) for (const capability of caps) rules.push({ capability, match: ['*'], effect: 'deny' });
  if (!canPublish) rules.push({ capability: 'mcp', match: KIRO_PUBLISHING, effect: 'deny' });
  // Servers the persona turned off: their tools are denied.
  if (usesHostSetup && mcpOff.length) rules.push({ capability: 'mcp', match: mcpOff.map((n) => `${n}/*`), effect: 'deny' });
  // Isolated: every server but Postbox’s is denied. An empty Kiro home and includeMcpJson: false aren’t enough on
  // their own: a managed install can add its own server, and an allow rule for it, to every agent file when the
  // CLI starts (seen with a toolbox-installed kiro-cli 2.33.1), and the deny beats that allow. Checked live: a second
  // server’s call was refused by this rule while Postbox’s went through (tests/fixtures/kiro-cli/isolated-deny.jsonl).
  // Kiro still lists the denied server’s tools to the model; it refuses the call.
  if (!usesHostSetup) rules.push({ capability: 'mcp', match: ['*/*'], exclude: [`${POSTBOX_SERVER}/*`], effect: 'deny' });
  return rules;
}

/**
 * Auto’s allows (#136): the ticked Tools’ capabilities, and MCP tools, whose publishing and turned-off ones a deny
 * still refuses. @param {Set<string>} has  the persona’s ticked Tools
 */
function autoAllows(has) {
  const ticked = Object.entries(KIRO_TOOL_RULES).filter(([id]) => has.has(id));
  return [
    ...ticked.flatMap(([, caps]) => caps.map((capability) => ({ capability, match: ['*'], effect: 'allow' }))),
    { capability: 'mcp', match: ['*/*'], effect: 'allow' },
  ];
}

// A live turn (kiro-cli 2.33.1) had a command refused as “The user rejected this tool call.”, and the agent told the
// person they had declined it. Nobody was asked, so the agent is told what a refusal means here.
const HEADLESS_NOTE =
  '## Refused tool calls\n\nPostbox runs you headless, so Kiro can’t ask the person to approve a tool call: one that would need approval is refused, and Kiro reports it as “The user rejected this tool call.” The person didn’t see or decline it. Say which call was refused and that the agent’s permissions in Postbox didn’t allow it, then carry on without it.';

// Kiro’s v3 engine gives the model MCP tools only on demand, through its loader and tool_call (“Tool Load”), and an
// agent never told so may never load Postbox’s (#489). Kiro has named the loader two ways, each recorded: `tool_load`
// with ids such as `postbox::show_block` (tests/fixtures/kiro-cli/block.jsonl), and on kiro-cli 3.6.2 `load_resource`
// with ids such as `tool::postbox::show_block` (tool-load-deepseek.jsonl). Both are named, so an agent isn’t sent
// looking for one its Kiro doesn’t have.
const TOOL_LOAD_NOTE = `## Postbox’s tools\n\nKiro loads MCP tools on demand. The first time you use one of Postbox’s in a session, load it with whichever loader you have: \`load_resource\` with its id, such as \`tool::${POSTBOX_SERVER}::show_block\` or \`tool::${POSTBOX_SERVER}::read_message\`, or \`tool_load\` with \`${POSTBOX_SERVER}::show_block\`. Then run it with \`tool_call\` and the id the loader gave back, without loading it again. If neither loader is among your tools, or it doesn’t find Postbox’s, check again on your next turn rather than relying on an earlier answer, and say which in your reply.`;

// Kiro still lists a denied server’s tools to the model; it only refuses the call. In the mixed-room UAT, an Isolated
// agent offered “Manage scoped AWS credentials” from a server a managed install had added, so it’s told.
const ISOLATED_NOTE =
  '## Tools you can use\n\nOnly Postbox’s MCP server is allowed for you here. Tools from any other MCP server you see listed are refused, so don’t offer or use them, and don’t count them among what you can do.';

/**
 * The system prompt the agent file gives Kiro: Postbox’s guide, then what Postbox adds for Kiro (it runs headless, its
 * MCP tools load on demand, its size limit, and, for an Isolated persona, which tools it may use). What a turn records
 * as its guide (server/turn-prompt.mjs), as Kiro is given it. @param {any} persona @param {string} guide
 */
export const kiroSystemPrompt = (persona, guide) =>
  `${guide}\n\n${HEADLESS_NOTE}\n\n${TOOL_LOAD_NOTE}\n\n${SIZE_LIMIT_NOTE}${setupOf(persona).usesHostSetup ? '' : `\n\n${ISOLATED_NOTE}`}`;

/**
 * The custom agent for one turn. Pure, so the tests can check it.
 * @param {{ name: string, persona: any, mcpUrl?: string, shim?: { command: string, args: string[] }, guide: string, folders: string[], reads?: string[], kiroHome?: string|null, skills?: string | null }} turn
 *   shim: on a remote host, Postbox’s server is the host’s stdio shim, run as this command, in place of mcpUrl; the
 *   folders are then the host’s. skills: the folder of Postbox’s skills (agentSkills in agent-plugin.mjs), or null for
 *   none; a turn on a host has none, since the folder is on this computer. kiroHome: the Kiro home the turn runs with
 */
export function kiroAgent({ name, persona, mcpUrl = '', shim, guide, folders, reads = [], kiroHome = null, skills = shim ? null : agentSkills() }) {
  const { usesHostSetup } = setupOf(persona);
  return {
    name,
    description: `@${persona.handle} in Postbox`,
    prompt: kiroSystemPrompt(persona, guide),
    tools: ['*'],
    // Your global and workspace mcp.json, unless the persona is Isolated.
    includeMcpJson: usesHostSetup,
    // A local server is a command and its arguments (kiro.dev/docs/custom-agents/configuration-reference).
    mcpServers: { [POSTBOX_SERVER]: shim ? { command: shim.command, args: [...shim.args] } : { type: 'http', url: mcpUrl } },
    permissions: { rules: kiroRules({ persona, folders, reads, resolve: !shim, kiroHome }) },
    // Postbox’s skills, as a skill resource (kiro.dev/docs/custom-agents/configuration-reference), which loads a
    // skill’s description and its body only when it’s used. Checked with kiro-cli 2.34.1: visual-explainer was listed
    // among the session’s skills before the model ran, and the defaults an agent with no resources gets (AGENTS.md, the
    // project’s .kiro/steering and .kiro/skills) still loaded beside it.
    // Only the ones the persona keeps on (#207).
    ...(skills && postboxSkillsOn(persona).length ? { resources: postboxSkillsOn(persona).map((n) => `skill://${skills}/${n}/SKILL.md`) } : {}),
  };
}
