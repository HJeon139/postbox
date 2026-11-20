// What Antigravity’s PreToolUse hook (agy-hook.mjs) refuses in Run everything, where agy runs with
// --dangerously-skip-permissions and the hook is all that holds the persona’s limits.
//
// Web off goes by the words in a tool’s name, not a list of names, so a web tool a later agy adds is refused too (PR
// #1515’s review: a list missed view_content_chunk, which reads back a page agy fetched). The words come from agy’s
// own tool list, the agy_tool_safety monitor config built into the agy binary (its allowed_tools), and the browser
// tools the binary names: search_web, read_url_content, view_content_chunk, open_browser_url, read_browser_page,
// list_browser_pages, capture_browser_screenshot, browser_get_dom, browser_subagent and the rest.

const WEB_WORDS = /web|url|browser|search|fetch|chunk/;
/** agy’s own tools on that list whose names share those words but that read only the folder or the conversation. */
const LOCAL_TOOLS = new Set(['grep_search', 'search_in_file', 'trajectory_search']);

/** Whether a tool, by its lowercased name, reaches the web. @param {string} name */
export const isWebTool = (name) => WEB_WORDS.test(name) && !LOCAL_TOOLS.has(name);

/**
 * A Run everything call’s decision: refused when it needs a tool the persona turned off, else allowed.
 * @param {string} name  lowercased @param {{ tools: string[] }} persona
 */
export function decideBypass(name, { tools }) {
  if (isWebTool(name) && !tools.includes('web.fetch')) return { decision: 'deny', reason: 'The person turned Web off for this agent in Postbox.' };
  return { decision: 'allow' };
}
