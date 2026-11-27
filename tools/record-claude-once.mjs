// Records Postbox’s own two Haiku calls through the real `claude` CLI (server/claude-once.mjs, #1831), as the fixture
// tests/claude-once.test.mjs replays: a thread’s summary and the check on a write the person asked for, each with the
// prompt, arguments and system prompt Postbox sends, about a made-up conversation.
//
// It runs real model turns, which cost money: two Haiku calls, each a short prompt and a short answer. It prints what
// each one cost. Only the person runs it.
//
//   node tools/record-claude-once.mjs                 writes tests/fixtures/claude-code/once.json
//   node tools/record-claude-once.mjs --out <file>
//
// What’s kept is an allowlist: each run’s init (its version, model, tools, MCP servers and which kinds of memory it
// loaded, with every server and MCP tool renamed and no paths) and result (the answer, tokens and cost), with ids replaced. Your folders, commands, skills, plugins,
// server names and quota are left out.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findClaude } from '../server/adapters/claude-code.mjs';
import { claudeOnce } from '../server/claude-once.mjs';
import { SUMMARY_MODEL } from '../server/summary-model.mjs';
import { summaryPrompt } from '../server/thread-summary.mjs';
import { allowedQuote, judgePrompt } from '../server/write-intent.mjs';

const OUT = fileURLToPath(new URL('../tests/fixtures/claude-code/once.json', import.meta.url));
const TIMEOUT_MS = 60_000;
const NO_ID = '00000000-0000-0000-0000-000000000000';

/** The made-up thread and request, and the call the request asks for, worded as the judge reads one. */
const THREAD = 'The person: Should the list page by offset or by cursor?\n\n@developer: Cursor. Offsets skip rows when new ones arrive.';
export const ASKED = 'Please create the pull request for the pagination branch.';
export const CALL = 'Tool: Bash\nCommand:\ngh pr create --title "Page the list by cursor" --body "Offsets skip rows when new ones arrive."';
const TAG = 'a1b2c3d4e5f6';

const CALLS = [
  { call: 'summary', prompt: summaryPrompt(THREAD) },
  { call: 'judge', prompt: judgePrompt(TAG, ASKED, CALL) },
];

const isMcpTool = (/** @type {unknown} */ name) => String(name).startsWith('mcp__');
const pick = (/** @type {any} */ from, /** @type {string[]} */ keys) =>
  Object.fromEntries(keys.filter((k) => from?.[k] !== undefined).map((k) => [k, from[k]]));

/** One of the CLI’s messages as the fixture keeps it, or null to leave it out. @param {any} m */
function kept(m) {
  if (m?.type === 'system' && m.subtype === 'init')
    return {
      ...pick(m, ['type', 'subtype', 'claude_code_version', 'model', 'permissionMode']),
      ...(m.memory_paths ? { memory_paths: Object.keys(m.memory_paths) } : {}), // Which memory it loaded, never where.
      cwd: '/workspace/rec',
      session_id: NO_ID,
      tools: (m.tools ?? []).map((/** @type {string} */ t, /** @type {number} */ i) => (isMcpTool(t) ? `mcp__sanitized_mcp__tool_${i}` : t)),
      mcp_servers: (m.mcp_servers ?? []).map((/** @type {any} */ s) => ({ name: 'sanitized_mcp', status: s?.status })),
    };
  if (m?.type === 'result')
    return {
      ...pick(m, ['type', 'subtype', 'is_error', 'result', 'total_cost_usd', 'num_turns', 'duration_ms', 'stop_reason']),
      session_id: NO_ID,
      usage: pick(m.usage, ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']),
    };
  return null;
}

/** Asks once through claudeOnce, keeping what the CLI was given and what it printed. @param {string} bin @param {string} prompt */
async function record(bin, prompt) {
  const seen = { args: /** @type {string[]} */ ([]), out: '', err: '', exit: /** @type {number|null} */ (null) };
  const spawnImpl = /** @type {any} */ (
    (/** @type {string} */ b, /** @type {string[]} */ args, /** @type {any} */ opts) => {
      seen.args = args;
      const child = spawn(b, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] }); // Its stderr is kept, to report.
      child.stdout.on('data', (d) => (seen.out += d));
      child.stderr.on('data', (d) => (seen.err = (seen.err + d).slice(-4000)));
      child.on('close', (code) => (seen.exit = code));
      return child;
    }
  );
  const answer = await claudeOnce(bin, prompt, { model: SUMMARY_MODEL, timeoutMs: TIMEOUT_MS, spawnImpl });
  /** @type {any[]} */
  let said = [];
  try {
    said = [JSON.parse(seen.out)].flat();
  } catch {} // Not JSON: nothing to keep, and the report below shows what the CLI printed.
  return { answer, said, ...seen };
}

async function main() {
  const at = process.argv.indexOf('--out');
  const out = at > 0 ? process.argv[at + 1] : OUT;
  const bin = findClaude();
  console.log(`Two real ${SUMMARY_MODEL} calls through ${bin}. This costs money; each cost is printed below.`);
  const runs = [];
  let total = 0;
  let failed = false;
  for (const { call, prompt } of CALLS) {
    const r = await record(bin, prompt);
    const init = r.said.find((m) => m?.type === 'system' && m.subtype === 'init');
    console.log(`\n${call}: exit ${r.exit}`);
    if (!r.answer) {
      failed = true;
      console.log(`  NO ANSWER: Postbox would go on without one.\n  stderr: ${r.err.trim() || '(none)'}\n  stdout: ${r.out.slice(0, 2000) || '(none)'}`);
    } else {
      total += r.answer.costUsd ?? 0;
      console.log(`  answer: ${r.answer.text}\n  cost: $${r.answer.costUsd ?? 'not reported'}`);
      if (call === 'judge') console.log(`  Postbox reads it as: ${allowedQuote(r.answer.text, [ASKED], CALL) ? 'allow' : 'ask (a card)'} (allow is expected)`);
    }
    const u = r.said.find((m) => m?.type === 'result')?.usage;
    if (u) console.log(`  input tokens: ${(u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)}`);
    if (!init) console.log('  no init message in the output: what the call was offered isn’t shown');
    else {
      const tools = init.tools ?? [];
      console.log(`  tools offered: ${tools.length}, of them MCP tools: ${tools.filter(isMcpTool).length}; MCP servers: ${(init.mcp_servers ?? []).length}`);
      console.log(`  memory loaded: ${Object.keys(init.memory_paths ?? {}).join(', ') || 'none'}`);
    }
    runs.push({ call, args: r.args, exit: r.exit, output: r.said.map(kept).filter(Boolean) });
  }
  writeFileSync(out, `${JSON.stringify({ runs }, null, 2)}\n`);
  console.log(`\nTotal cost: $${total.toFixed(5)}. Wrote ${out}. Read it before you commit it.`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
