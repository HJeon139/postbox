// What Antigravity’s PreToolUse hook (agy-hook.mjs) refuses in Run everything, where agy runs with
// --dangerously-skip-permissions and the hook is all that holds the persona’s limits: Shell and Web here, and
// publishing, which agy-hook.mjs refuses in every mode (publishingCall), as Kiro’s and Claude Code’s Run everything do.
//
// Web off goes by the words in a tool’s name, not a list of names, so a web tool a later agy adds is refused too (PR
// #1515’s review: a list missed view_content_chunk, which reads back a page agy fetched). The words come from agy’s
// own tool list, as its init event names it (recorded: tests/fixtures/antigravity-cli/first.jsonl), and the
// agy_tool_safety monitor config built into the agy binary, which also names view_content_chunk, search_in_file and
// trajectory_search: search_web, read_url_content, open_browser_url, browser_get_dom, browser_subagent and the rest.

const WEB_WORDS = /web|url|browser|search|fetch|chunk/;
/** agy’s own tools on that list whose names share those words but that read only the folder or the conversation. */
const LOCAL_SEARCHES = new Set(['grep_search', 'search_in_file', 'trajectory_search']);

/** Whether a tool, by its lowercased name, reaches the web. @param {string} name */
export const isWebTool = (name) => WEB_WORDS.test(name) && !LOCAL_SEARCHES.has(name);

// Everything else goes by an allow-list from the same two sources, so a tool a later agy adds is refused until it’s
// listed here (PR #1515’s second review: notebook_execution and run_workflow ran code with Shell off).
/** agy’s tools that run commands or code, or edit a file as a command would (sed_file), now or later: need Shell. */
const CODE_TOOLS = new Set(['run_command', 'send_command_input', 'notebook_execution', 'notebook_edit', 'run_workflow', 'sed_file', 'schedule']);
/**
 * agy’s tools that work only in the agent’s folder, the conversation, Postbox (call_mcp_tool, judged by agy-hook.mjs’s
 * guards) or agy itself, allowed whatever the persona has. Not invoke_subagent or manage_subagents, since whether agy
 * runs hooks inside a subagent is unproved, nor send_message, which can reach agents outside the turn.
 */
const LOCAL_TOOLS = new Set([
  ...LOCAL_SEARCHES,
  ...['view_file', 'read_file', 'list_dir', 'find_by_name', 'command_status', 'read_terminal'],
  ...['write_to_file', 'write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content'],
  ...['call_mcp_tool', 'list_resources', 'read_resource', 'ask_question', 'ask_permission', 'ask_custom_permission'],
  ...['finish', 'wait', 'wait_5_seconds', 'task_boundary', 'notify_user', 'manage_task', 'manage_inbox'],
  ...['list_permissions', 'generate_image', 'delete_knowledge', 'define_subagent'],
]);

// An MCP server’s tools go by the same words in the server’s and the tool’s names, as fetch/fetch and
// playwright/browser_navigate do (the second review); Postbox’s own server isn’t the web.
const MCP_CALLS = new Set(['call_mcp_tool', 'list_resources', 'read_resource']);
/** @param {string} name @param {any} args */
const mcpReachesWeb = (name, args) =>
  MCP_CALLS.has(name) &&
  !['postbox_postbox', 'postbox'].includes(String(args?.ServerName ?? '')) &&
  WEB_WORDS.test(`${args?.ServerName ?? ''} ${args?.ToolName ?? ''}`.toLowerCase());

/**
 * A Run everything call’s decision, while the hook holds the persona’s limits: refused when it needs Web or Shell and
 * the persona turned it off, or when it isn’t one of agy’s tools Postbox knows; else allowed.
 * @param {string} name  lowercased @param {{ tools: string[] }} persona @param {any} [args]  the call’s
 */
export function decideBypass(name, { tools }, args = {}) {
  const web = isWebTool(name) || mcpReachesWeb(name, args);
  if (web && !tools.includes('web.fetch')) return { decision: 'deny', reason: 'The person turned Web off for this agent in Postbox.' };
  if (CODE_TOOLS.has(name) && !tools.includes('shell')) return { decision: 'deny', reason: 'The person turned Shell off for this agent in Postbox.' };
  if (web || CODE_TOOLS.has(name) || LOCAL_TOOLS.has(name)) return { decision: 'allow' };
  return { decision: 'deny', reason: `Postbox doesn’t know Antigravity’s ${name} tool, so it can’t keep this agent’s limits with it.` };
}

/** What Run everything’s hook refuses when the persona turned it off: Shell, Web, and publishing (agyRules’s 'publish'). */
export const HOOK_REFUSES = ['shell', 'web.fetch', 'publish'];

/**
 * What the rules file says about who holds the persona’s limits: the hook, for those it refuses, and the agent, for
 * the rest, which Antigravity can’t enforce.
 * @param {string[]} refused  in words @param {boolean} rest  whether any limit isn’t refused
 */
export function whoHolds(refused, rest) {
  const hook = refused.length ? ` Postbox’s permission hook refuses ${rest ? `${refused.join('; ')}.` : 'them, so say so if a task needs one.'}` : '';
  const agent = rest
    ? ` Antigravity can’t enforce ${refused.length ? 'the rest' : 'that'}, so it’s up to you: don’t do them, and say so if a task needs one.`
    : '';
  return hook + agent;
}
