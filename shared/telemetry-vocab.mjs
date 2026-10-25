// Postbox’s own vocabulary for a telemetry report (designs/telemetry-persona.md, R12–R13, R16): every value a report may
// hold is one of these, a number, or a Postbox ref. The final check (shared/telemetry.mjs) accepts nothing else, so a
// project’s words, in any spelling or encoding, have no field to go in.

import { CATALOG } from './catalog.mjs';
import { REACTIONS } from './reactions.mjs';

/** MAST’s failure modes (Cemri et al. 2025): 5 of system design, 6 of inter-agent misalignment, 3 of task verification. */
export const MAST = [
  'none',
  'FM-1.1',
  'FM-1.2',
  'FM-1.3',
  'FM-1.4',
  'FM-1.5',
  'FM-2.1',
  'FM-2.2',
  'FM-2.3',
  'FM-2.4',
  'FM-2.5',
  'FM-2.6',
  'FM-3.1',
  'FM-3.2',
  'FM-3.3',
];
/** The repository’s `area:` labels. */
export const AREAS = ['agent-contract', 'apps', 'backends', 'blocks', 'checks', 'shell', 'threads'];
/** Who a failure is on, in the UAT’s verdict words. */
export const ATTRIBUTIONS = ['confirmed', 'agent', 'by-design', 'unsure'];
export const CONFIDENCE = ['low', 'medium', 'high'];
export const EMOJIS = REACTIONS.map(([e]) => e);
/** The flag among the reactions; the rest are feedback (R9). */
export const FLAG = '🚩';

/** What Postbox runs agents on, and offers them; anything else is “other”. */
export const BACKENDS = ['claude-code', 'agent-sdk', 'kiro-cli', 'antigravity-cli', 'codex', 'mock', 'other'];
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'mock', 'other'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODES = ['auto', 'ask', 'acceptEdits', 'bypass'];
export const TOOL_IDS = ['corpus.search', 'corpus.read', 'corpus.stats', 'web.fetch', 'arxiv.search', 'shell', 'narrate.speak', 'agents.outside'];
/** The boilerplates an agent is named for, when both its handle and its instructions are theirs, unchanged. */
export const BOILERPLATE_IDS = ['researcher', 'developer', 'critic'];

/** Postbox’s MCP tools, a tool call’s class by name. */
export const POSTBOX_TOOLS = [
  'show_block',
  'update_block',
  'review_block',
  'show_app',
  'update_app',
  'retire_app',
  'define_term',
  'react',
  'propose_agent',
  'schedule_wake',
  'wake_agent',
  'bring_to_conversation',
  'read_conversation',
  'read_message',
  'permission_prompt',
  'ask_for_tool',
  'corpus_search',
  'add_dataset',
];
/** Claude Code’s own tools, a call’s class by name; one not listed is “other”. */
export const BUILT_INS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Monitor',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
  'Skill',
  'TaskStop',
  'EnterWorktree',
  'ExitWorktree',
];
/** Programs a command is counted by; anything else is “other” (R12): a command line is the person’s, its program isn’t. */
export const PROGRAMS = [
  'git',
  'gh',
  'npm',
  'npx',
  'node',
  'python',
  'python3',
  'pytest',
  'pip',
  'uv',
  'make',
  'cargo',
  'go',
  'ls',
  'cat',
  'grep',
  'rg',
  'sed',
  'find',
];
/** Every tool call’s class: a Postbox tool, a built-in, a command by program, another MCP server’s, or other. */
export const TOOL_CLASSES = [
  ...POSTBOX_TOOLS.map((t) => `postbox:${t}`),
  ...BUILT_INS,
  ...PROGRAMS.map((p) => `command:${p}`),
  'command:other',
  'mcp',
  'other',
];

export const BLOCK_TYPES = Object.keys(CATALOG);
export const WOKE = ['person', 'wake', 'answer', 'schedule', 'postbox', 'unknown'];
export const ENDED = ['done', 'failed', 'stopped', 'unknown'];
export const OUTCOMES = ['allowed', 'always', 'edited', 'denied', 'expired', 'open'];
/** Log buckets for a count or size, so an exact number can’t identify a change or carry a value (R12). */
export const BUCKETS = ['0', '1-9', '10-99', '100-999', '1000-9999', '10000-99999', '100000-999999', '1000000+'];
/** A duration’s bucket, and a cost’s, in cents to the nearest power of ten (R12). */
export const DURATIONS = ['under-1s', '1-9s', '10-59s', 'minutes', 'hours'];
export const COSTS = ['0', 'under-1c', '1c', '10c', '1usd', '10usd', '100usd'];
export const GAP_KINDS = ['no-stream', 'transcript', 'check', 'classifier', 'events', 'sweep'];
export const GAP_REASONS = [
  'before-recording',
  'not-recorded',
  'running',
  'unreadable',
  'threw',
  'over-budget',
  'failed-call',
  'no-classifier',
  'write-failed',
];
/** Why a label is unlabeled (R3, R16): the gate rejected its value, or the classifier had no say in it. */
export const UNLABELED_REASONS = ['rejected', 'over-budget', 'failed-call', 'no-classifier'];
/** The facts a check may need (server/room-checks.mjs, inputs). */
export const INPUTS = [
  'state',
  'threads',
  'streams',
  'kiroStreams',
  'agyStreams',
  'codexStreams',
  'events',
  'transcripts',
  'freshInstall',
  'console',
  'apps',
  'probes',
  'samples',
  'ui',
  'userMcpServers',
  'telemetry',
];

/** A count’s bucket. */
export const bucket = (n) => (!(n > 0) ? '0' : BUCKETS[Math.min(BUCKETS.length - 1, 1 + Math.floor(Math.log10(n) + 1e-9))]);
/** A duration’s bucket, from milliseconds. */
export const duration = (ms) => (ms < 1000 ? 'under-1s' : ms < 1e4 ? '1-9s' : ms < 6e4 ? '10-59s' : ms < 36e5 ? 'minutes' : 'hours');
/** A cost’s bucket: cents to the nearest power of ten. */
export const cost = (usd) => {
  if (!(usd > 0)) return '0';
  const tens = Math.round(Math.log10(usd * 100));
  return tens < 0 ? 'under-1c' : COSTS[Math.min(COSTS.length - 1, 2 + tens)];
};
