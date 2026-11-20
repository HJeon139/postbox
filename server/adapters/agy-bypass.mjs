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
const LOCAL_TOOLS = new Set(['grep_search', 'search_in_file', 'trajectory_search']);

/** Whether a tool, by its lowercased name, reaches the web. @param {string} name */
export const isWebTool = (name) => WEB_WORDS.test(name) && !LOCAL_TOOLS.has(name);

/**
 * A Run everything call’s decision: refused when it needs Shell or Web and the persona turned it off, else allowed.
 * @param {string} name  lowercased @param {{ tools: string[] }} persona
 */
export function decideBypass(name, { tools }) {
  if (name === 'run_command' && !tools.includes('shell')) return { decision: 'deny', reason: 'The person turned Shell off for this agent in Postbox.' };
  if (isWebTool(name) && !tools.includes('web.fetch')) return { decision: 'deny', reason: 'The person turned Web off for this agent in Postbox.' };
  return { decision: 'allow' };
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
