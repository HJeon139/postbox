// The custom agent Kiro runs for one turn, moved out of kiro-cli.mjs: its prompt notes and its permission rules.

import { realpathSync } from 'node:fs';
import { SIZE_LIMIT_NOTE } from './kiro-errors.mjs';
import { POSTBOX_SERVER, setupOf } from './setup.mjs';
import { postboxSkillDirs } from './skill-config.mjs';

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

/** A folder as given and as resolved: Kiro matches resolved paths (/tmp is /private/tmp on macOS). */
const spellings = (dir) => {
  try {
    const real = realpathSync(dir);
    return real === dir ? [dir] : [dir, real];
  } catch {
    return [dir];
  }
};

/**
 * The agent’s permission rules. Their order doesn’t matter: in Kiro, deny beats ask beats allow, whatever the scope
 * a rule comes from (kiro.dev/docs/permissions), so a deny here holds against an allow in your own rules.
 * @param {{ persona: any, folders: string[], resolve?: boolean }} turn  folders: where the agent works, and the folders
 *   it may also use; resolve: also name each as resolved here (false for a host’s folders, which aren’t on this disk)
 */
export function kiroRules({ persona, folders, resolve = true }) {
  const { canPublish, usesHostSetup, mcpOff } = setupOf(persona);
  const has = new Set(Array.isArray(persona?.tools) ? persona.tools : []);
  const dirs = [...new Set(folders.filter(Boolean).flatMap(resolve ? spellings : (d) => [d]))];
  const rules = [
    // Postbox’s own tools never need asking: they only show things in the thread.
    { capability: 'mcp', match: [`${POSTBOX_SERVER}/*`], effect: 'allow' },
  ];
  if (dirs.length) rules.push({ capability: 'fs_read', match: dirs, effect: 'allow' });
  if (persona?.permissionMode === 'acceptEdits' && dirs.length) rules.push({ capability: 'fs_write', match: dirs, effect: 'allow' });
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

// A live turn (kiro-cli 2.33.1) had a command refused as “The user rejected this tool call.”, and the agent told the
// person they had declined it. Nobody was asked, so the agent is told what a refusal means here.
const HEADLESS_NOTE =
  '## Refused tool calls\n\nPostbox runs you headless, so Kiro can’t ask the person to approve a tool call: one that would need approval is refused, and Kiro reports it as “The user rejected this tool call.” The person didn’t see or decline it. Say which call was refused and that the agent’s permissions in Postbox didn’t allow it, then carry on without it.';

// Kiro still lists a denied server’s tools to the model; it only refuses the call. In the mixed-room UAT, an Isolated
// agent offered “Manage scoped AWS credentials” from a server a managed install had added, so it’s told.
const ISOLATED_NOTE =
  '## Tools you can use\n\nOnly Postbox’s MCP server is allowed for you here. Tools from any other MCP server you see listed are refused, so don’t offer or use them, and don’t count them among what you can do.';

/**
 * The custom agent for one turn. Pure, so the tests can check it.
 * @param {{ name: string, persona: any, mcpUrl?: string, shim?: { command: string, args: string[] }, guide: string, folders: string[], skills?: string[] }} turn
 *   shim: on a remote host, Postbox’s server is the host’s stdio shim, run as this command, in place of mcpUrl; the
 *   folders are then the host’s. skills: the folders of Postbox’s skills the persona left on (postboxSkillDirs in
 *   skill-config.mjs); a turn on a host has none, since the folders are on this computer
 */
export function kiroAgent({ name, persona, mcpUrl = '', shim, guide, folders, skills = shim ? [] : postboxSkillDirs(persona) }) {
  const { usesHostSetup } = setupOf(persona);
  return {
    name,
    description: `@${persona.handle} in Postbox`,
    prompt: `${guide}\n\n${HEADLESS_NOTE}\n\n${SIZE_LIMIT_NOTE}${usesHostSetup ? '' : `\n\n${ISOLATED_NOTE}`}`,
    tools: ['*'],
    // Your global and workspace mcp.json, unless the persona is Isolated.
    includeMcpJson: usesHostSetup,
    // A local server is a command and its arguments (kiro.dev/docs/custom-agents/configuration-reference).
    mcpServers: { [POSTBOX_SERVER]: shim ? { command: shim.command, args: [...shim.args] } : { type: 'http', url: mcpUrl } },
    permissions: { rules: kiroRules({ persona, folders, resolve: !shim }) },
    // Postbox’s skills, one skill resource each (kiro.dev/docs/custom-agents/configuration-reference), which loads a
    // skill’s description and its body only when it’s used. Checked with kiro-cli 2.34.1: visual-explainer was listed
    // among the session’s skills before the model ran, and the defaults an agent with no resources gets (AGENTS.md, the
    // project’s .kiro/steering and .kiro/skills) still loaded beside it.
    ...(skills.length ? { resources: skills.map((dir) => `skill://${dir}/SKILL.md`) } : {}),
  };
}
