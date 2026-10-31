// Writes outside Postbox wait for the person (#112). An agent asked to define a use case document created it straight
// in a shared folder of an external doc tool, with a number already taken and links that went nowhere, and everyone
// with access saw it before the person did. Now each call that writes outside (WRITE_TOOLS in
// server/adapters/setup.mjs, passed to Claude Code as ask rules) comes to Postbox’s permission card, which shows the
// draft as the person will publish it. Calls the person has already settled pass without a card:
// - one the persona may publish (“Can publish outside Postbox”, the publishing tools);
// - one an allow rule names exactly, as Always allow on the card saves it: the tool itself (mcp__docs__create_document),
//   not its whole server, which a person may have allowed for its reads; for gh, a rule with a command pattern.

import { passesWriteCheck, ruleMatches, splitCommand } from '../shared/permission-match.mjs';
import { isPublishingTool, POSTBOX_SERVER, setupOf, WRITE_TOOLS } from './adapters/setup.mjs';
import { readRules } from './permission-rules.mjs';

const MCP_RULES = WRITE_TOOLS.filter((r) => r.startsWith('mcp__'));
const BASH_RULES = WRITE_TOOLS.filter((r) => r.startsWith('Bash('));
const NOWHERE = { cwd: '/', home: '/' };

/**
 * The calls of a tool call that write outside Postbox: the call itself for an MCP tool, each gh part of a command.
 * @param {string} tool @param {any} input
 * @returns {{ tool: string, arg: string|null }[]}
 */
export function writeCalls(tool, input) {
  const name = String(tool ?? '');
  if (name === 'Bash')
    return splitCommand(String(input?.command ?? ''))
      .map((arg) => ({ tool: 'Bash', arg }))
      .filter((c) => BASH_RULES.some((r) => ruleMatches(r, c, NOWHERE)));
  const call = { tool: name, arg: null };
  return name.startsWith('mcp__') && MCP_RULES.some((r) => ruleMatches(r, call, NOWHERE)) ? [call] : [];
}

/** Whether a tool call writes outside Postbox. */
export const isWriteCall = (tool, input) => writeCalls(tool, input).length > 0;

/**
 * Whether the person has already settled this write, so it runs without a card (see the top of this file).
 * @param {any} rt  the Runtime @param {string} sessionId @param {{ tool: string, input?: any }} req
 */
export async function writePasses(rt, sessionId, { tool, input }) {
  const calls = writeCalls(tool, input);
  if (!calls.length) return false;
  // Postbox’s own tools only show things in the conversation. A write rule that matches one (add_dataset matches
  // mcp__*__add_*: Claude Code’s globs can’t leave a server out) costs a permission_prompt round trip, never a card.
  if (String(tool).startsWith(`mcp__${POSTBOX_SERVER}__`)) return true;
  const { se, persona, folder } = await rt.panelTarget({ sessionId });
  const { canPublish, usesHostSetup } = setupOf(persona);
  if (canPublish && isPublishingTool(tool)) return true;
  const files = folder && rt.readsRules(persona.backend) ? await readRules({ folder, home: rt.home, configDir: rt.configDir, usesHostSetup }) : [];
  const allow = [
    ...files.flatMap((f) => f.allow.map((rule) => ({ rule, root: f.source === 'user' ? rt.home : folder }))),
    ...[...(se?.rules?.allow ?? []), ...(se?.allowOnce ?? [])].map((rule) => ({ rule, root: folder })),
  ];
  return calls.every((c) => allow.some((a) => passesWriteCheck(a.rule, c, { cwd: folder ?? '/', home: rt.home, root: a.root ?? folder ?? '/' })));
}

/**
 * Whether one of the person’s own ask rules covers this call: in their settings files, or this conversation’s. Their
 * “always ask me” keeps its card even where Postbox’s rules for writes outside also catch the call (#296). A settings
 * file Postbox can’t read might hold one, so it counts as one.
 * @param {any} rt  the Runtime @param {string} sessionId @param {{ tool: string, input?: any }} req
 */
export async function personAsks(rt, sessionId, { tool, input }) {
  const { se, persona, folder } = await rt.panelTarget({ sessionId });
  const { usesHostSetup } = setupOf(persona);
  const files = folder && rt.readsRules(persona.backend) ? await readRules({ folder, home: rt.home, configDir: rt.configDir, usesHostSetup }) : [];
  if (files.some((f) => f.error)) return true;
  const ask = [
    ...files.flatMap((f) => f.ask.map((rule) => ({ rule, root: f.source === 'user' ? rt.home : folder }))),
    ...(se?.rules?.ask ?? []).map((rule) => ({ rule, root: folder })),
  ];
  const calls = tool === 'Bash' ? splitCommand(String(input?.command ?? '')).map((arg) => ({ tool, arg })) : [{ tool: String(tool), arg: null }];
  return calls.some((c) => ask.some((a) => ruleMatches(a.rule, c, { cwd: folder ?? '/', home: rt.home, root: a.root ?? folder ?? '/' })));
}

// The input fields that name where a write lands, most specific first.
const TARGET_FIELDS = [
  ['folder', 'folder'],
  ['folder_id', 'folder'],
  ['database', 'database'],
  ['database_id', 'database'],
  ['parent', 'parent'],
  ['parent_id', 'parent'],
  ['parent_page_id', 'parent page'],
  ['repo', 'repository'],
  ['repository', 'repository'],
  ['channel', 'channel'],
  ['channel_id', 'channel'],
  ['space', 'space'],
  ['space_key', 'space'],
  ['project', 'project'],
  ['project_id', 'project'],
  ['team', 'team'],
  ['path', 'path'],
];

/** A word of a command without its quotes, cut to fit a card. */
const unquoted = (w) => w.replace(/^["']|["']$/g, '').slice(0, 120);

/**
 * Where one write in a command lands: a push on its remote (--repo when it names one, else the first word after push
 * that isn’t a flag), a gh write on the repository its --repo or -R names (#296).
 * @param {string} part @returns {{ server: string, target: { what: string, name: string } | null }}
 */
function commandWhere(part) {
  const words = part.trim().split(/\s+/);
  const at = words.indexOf('push');
  if (words[0] === 'git' && at > 0) {
    const rest = words.slice(at + 1);
    const flag = rest.findIndex((w) => w === '--repo' || w.startsWith('--repo='));
    const remote = flag < 0 ? rest.find((w) => !w.startsWith('-')) : rest[flag].includes('=') ? rest[flag].split('=')[1] : rest[flag + 1];
    return { server: 'git', target: remote ? { what: 'remote', name: unquoted(remote) } : null };
  }
  const repo = /(?:^|\s)(?:--repo|-R)[=\s]+(\S+)/.exec(part)?.[1];
  return { server: 'gh', target: repo ? { what: 'repository', name: unquoted(repo) } : null };
}

/**
 * Where a write lands, for its card: the server (or gh, or git), and the target when the input names one, such as a
 * folder, a database, a repository or a remote. An object target (Notion’s parent: { page_id }) gives its first text
 * value. A command that writes to more than one place lists the others in also, as git push && gh pr create does.
 * @param {string} tool @param {any} input
 * @returns {{ server: string, target: { what: string, name: string } | null, also?: { server: string, target: { what: string, name: string } | null }[] }}
 */
export function whereOf(tool, input) {
  const name = String(tool ?? '');
  if (name === 'Bash') {
    const places = [];
    for (const c of writeCalls(name, input)) {
      const w = commandWhere(String(c.arg));
      if (!places.some((p) => JSON.stringify(p) === JSON.stringify(w))) places.push(w);
    }
    const [first = { server: 'gh', target: null }, ...also] = places;
    return also.length ? { ...first, also } : first;
  }
  const server = (/^mcp__(.+?)__/.exec(name)?.[1] ?? name).replace(/^claude_ai_/, 'claude.ai ').replace(/_/g, ' ');
  const i = input && typeof input === 'object' ? input : {};
  for (const [field, what] of TARGET_FIELDS) {
    const v = i[field];
    const text = typeof v === 'string' ? v : v && typeof v === 'object' ? Object.values(v).find((x) => typeof x === 'string') : null;
    if (text?.trim()) return { server, target: { what, name: String(text).slice(0, 120) } };
  }
  return { server, target: null };
}

// The input fields a write tool carries its text in, most specific first.
const DRAFT_FIELDS = ['markdown', 'content', 'body', 'text', 'message', 'description'];

/**
 * The draft a write carries, to show as the person will publish it: its longest text field, as Markdown, or null.
 * Only for MCP tools that write outside Postbox; a file tool’s content is code, and a command is shown as it is.
 * @param {string} tool @param {any} input
 * @returns {{ field: string, text: string } | null}
 */
export function draftOf(tool, input) {
  if (!String(tool ?? '').startsWith('mcp__') || !isWriteCall(tool, input) || !input || typeof input !== 'object') return null;
  const found = DRAFT_FIELDS.filter((f) => typeof input[f] === 'string' && input[f].trim()).sort((a, b) => input[b].length - input[a].length)[0];
  return found ? { field: found, text: String(input[found]).slice(0, 20000) } : null;
}
