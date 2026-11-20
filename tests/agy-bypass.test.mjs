// Run everything for an Antigravity persona (server/adapters/agy-bypass.mjs): agy runs with
// --dangerously-skip-permissions, so the PreToolUse hook is all that holds the persona’s limits. With Web off it
// refuses every tool whose name looks like the web, by its words rather than a list of names, so a tool a later agy
// adds is refused too, and allows only agy’s own local tools that share those words (PR #1515’s review).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyTool } from '../server/adapters/agy-hook.mjs';
import { tempDir } from './temp-dirs.mjs';

/** @param {string} name @param {{ tools?: string[], canPublish?: boolean }} [o] */
function bypass(name, { tools = [], canPublish = false } = {}, args = {}) {
  const ws = join(tempDir('pb-agy-bypass-'), 'ws');
  return decideAgyTool({ toolCall: { name, args } }, { mode: 'bypass', folders: [ws], cwd: ws, tools, canPublish }).decision;
}

// Names from agy’s own tool list: the agy_tool_safety monitor config built into the agy binary (allowed_tools),
// and the browser tools its binary names.
const WEB = [
  'search_web',
  'read_url_content',
  'view_content_chunk',
  'open_browser_url',
  'read_browser_page',
  'list_browser_pages',
  'capture_browser_screenshot',
  'capture_browser_console_logs',
  'click_browser_pixel',
  'execute_browser_javascript',
  'browser_get_dom',
  'browser_list_network_requests',
  'browser_get_network_request',
  'browser_subagent',
  'search_marketplace',
];

test('Run everything with Web off refuses agy’s web tools, whatever their case, and any new one named like them', () => {
  for (const name of WEB) assert.equal(bypass(name), 'deny', name);
  for (const name of ['Search_Web', 'VIEW_CONTENT_CHUNK', 'Read_Url_Content']) assert.equal(bypass(name), 'deny', name);
  for (const name of ['fetch_page', 'web_preview', 'open_url', 'deep_search', 'read_chunk']) assert.equal(bypass(name), 'deny', name);
});

test('Run everything with Web off still allows agy’s local tools that share those words', () => {
  for (const name of ['grep_search', 'search_in_file', 'trajectory_search', 'view_file', 'list_dir', 'find_by_name', 'write_to_file'])
    assert.equal(bypass(name, {}, { TargetFile: 'notes.md' }), 'allow', name);
});

test('Run everything with Web on allows the web tools', () => {
  for (const name of WEB) assert.equal(bypass(name, { tools: ['web.fetch'] }), 'allow', name);
});
