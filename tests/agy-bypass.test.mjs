// Run everything for an Antigravity persona (server/adapters/agy-bypass.mjs): agy runs with
// --dangerously-skip-permissions, so the PreToolUse hook is all that holds the persona’s limits. With Web off it
// refuses every tool whose name looks like the web, by its words rather than a list of names, so a tool a later agy
// adds is refused too, and allows only agy’s own local tools that share those words (PR #1515’s review). Every other
// tool goes by an allow-list, its code tools only with Shell, so one agy adds later is refused (the second review).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyTool } from '../server/adapters/agy-hook.mjs';
import { tempDir } from './temp-dirs.mjs';

/** @param {string} name @param {{ tools?: string[], canPublish?: boolean }} [o] */
function bypass(name, { tools = [], canPublish = false } = {}, args = {}) {
  const ws = join(tempDir('pb-agy-bypass-'), 'ws');
  return decideAgyTool({ toolCall: { name, args } }, { mode: 'bypass', folders: [ws], cwd: ws, tools, canPublish }).decision;
}

// agy’s own tool list, as its init event names it (recorded), and the three names from the agy_tool_safety monitor
// config built into the agy binary that the recording’s agy didn’t list yet.
const RECORDED = /** @type {string[]} */ (
  JSON.parse(readFileSync(new URL('fixtures/antigravity-cli/first.jsonl', import.meta.url), 'utf8').split('\n')[0]).init.tools
);
const AGY_TOOLS = [...RECORDED, 'view_content_chunk', 'search_in_file', 'trajectory_search'];
const WEB = [
  'browser_click_element',
  'browser_drag_pixel_to_pixel',
  'browser_get_dom',
  'browser_get_network_request',
  'browser_input',
  'browser_list_network_requests',
  'browser_mouse_down',
  'browser_mouse_up',
  'browser_move_mouse',
  'browser_press_key',
  'browser_refresh_page',
  'browser_resize_window',
  'browser_scroll',
  'browser_scroll_dom',
  'browser_select_option',
  'browser_subagent',
  'capture_browser_console_logs',
  'capture_browser_screenshot',
  'click_browser_pixel',
  'execute_browser_javascript',
  'list_browser_pages',
  'open_browser_url',
  'read_browser_page',
  'read_url_content',
  'search_marketplace',
  'search_web',
  'view_content_chunk',
];

// The tools that work only in the agent’s folder, the conversation, Postbox or agy itself: allowed whatever the
// persona has. Every other tool of agy’s is refused, and so is one it adds later (PR #1515’s second review).
const LOCAL = [
  'ask_custom_permission',
  'ask_permission',
  'ask_question',
  'call_mcp_tool',
  'command_status',
  'define_subagent',
  'delete_knowledge',
  'find_by_name',
  'finish',
  'generate_image',
  'grep_search',
  'list_dir',
  'list_permissions',
  'list_resources',
  'manage_inbox',
  'manage_task',
  'multi_replace_file_content',
  'read_resource',
  'replace_file_content',
  'search_in_file',
  'trajectory_search',
  'view_file',
  'wait',
  'wait_5_seconds',
  'write_to_file',
];
// The tools that run commands or code, or edit a file the way a command would: allowed only with Shell.
const CODE = ['notebook_edit', 'notebook_execution', 'run_command', 'run_workflow', 'schedule', 'sed_file', 'send_command_input'];

test('Run everything with Web off allows only agy’s local tools, and its code tools only with Shell', () => {
  assert.ok(RECORDED.length > 50, 'the recording names agy’s tools');
  const allowed = (/** @type {string[]} */ tools) =>
    AGY_TOOLS.filter((name) => bypass(name, { tools }, { TargetFile: 'notes.md', ServerName: 'github', ToolName: 'list_issues' }) === 'allow').sort();
  assert.deepEqual(allowed([]), LOCAL);
  assert.deepEqual(allowed(['shell']), [...LOCAL, ...CODE].sort());
  // The ones a hook may not see inside, or that reach agents outside the turn, aren’t on the list.
  for (const name of ['invoke_subagent', 'manage_subagents', 'send_message', 'list_plugin_accounts', 'a_tool_agy_adds_later'])
    assert.equal(bypass(name, { tools: ['shell'] }), 'deny', name);
});

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

test('Run everything refuses a command without Shell, as Kiro’s and Claude Code’s do', () => {
  const cmd = { CommandLine: 'curl https://example.com' };
  assert.equal(bypass('run_command', {}, cmd), 'deny');
  assert.equal(bypass('Run_Command', { tools: ['web.fetch'] }, cmd), 'deny');
  assert.equal(bypass('run_command', { tools: ['shell'] }, cmd), 'allow');
});

test('Run everything refuses a publishing tool unless the persona can publish', () => {
  const slack = { ServerName: 'slack', ToolName: 'send_message', Arguments: {} };
  assert.equal(bypass('call_mcp_tool', {}, slack), 'deny');
  assert.equal(bypass('call_mcp_tool', { canPublish: true }, slack), 'allow');
  assert.equal(bypass('call_mcp_tool', {}, { ServerName: 'postbox_postbox', ToolName: 'show_block', Arguments: {} }), 'allow');
});
