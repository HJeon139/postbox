// What an agent’s background tools are doing (#129), from streams recorded on claude 2.1.296:
// - monitor.jsonl and monitor-ps.txt: a Monitor call that runs past five replies, and its tool shell (recorded for
//   #129 on 23 October 2026);
// - background-moved.jsonl: a Bash call moved to the background at its timeout, cut from the HotpotQA UAT of
//   22 October 2026 (uat-runs/2026-10-22T01-02-09-hotpotqa, @critic’s stream 1792631182753).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { parsePs, stopJobUnder } from '../server/adapters/process-group.mjs';

const fixture = (name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

/**
 * Replays a recorded stream, or the lines given; `at` is what had been reported when each line was pushed, by the line’s
 * index.
 */
function replay(name, given = null) {
  const calls = { activity: /** @type {any[]} */ ([]), status: /** @type {any[]} */ ([]), jobs: /** @type {any[]} */ ([]), text: '' };
  const ctx = {
    activity: (a) => calls.activity.push(a),
    // A copy, as the runtime takes: the mapper’s subagent entries change as it goes.
    status: (s) => calls.status.push(structuredClone(s)),
    job: (j) => calls.jobs.push(j),
    text: (d) => {
      calls.text += d;
    },
    compaction() {},
  };
  const m = createStreamMapper(ctx, { now: () => 1000 });
  const lines = given ?? fixture(name);
  /** @type {{ activity: number, status: number }[]} */
  const at = [];
  for (const e of lines) {
    m.push(e);
    at.push({ activity: calls.activity.length, status: calls.status.length });
  }
  /** Each step as the list shows it: its reports merged, as the runtime merges them. */
  const steps = () => {
    const out = new Map();
    for (const s of calls.activity) out.set(s.id, { ...out.get(s.id), ...s });
    return [...out.values()];
  };
  /** The subagents as last reported by the given line. */
  const subsAt = (i) =>
    calls.status
      .slice(0, at[i].status)
      .filter((s) => s.subagents)
      .at(-1)?.subagents ?? [];
  /** A step as last reported by the given line. */
  const stepAt = (i, id) =>
    calls.activity
      .slice(0, at[i].activity)
      .filter((s) => s.id === id)
      .at(-1);
  return { calls, lines, steps, subsAt, stepAt };
}
const lineOf = (lines, fn) => lines.findIndex(fn);

test('#129: a recorded Monitor call is a background job: its step reads running through five replies, until it ends', () => {
  const { calls, lines, stepAt } = replay('monitor');
  const id = 'toolu_01GEVsa5H5sFq2QqAzmdh4fZ';
  const results = lines.flatMap((e, i) => (e.type === 'result' ? [i] : []));
  const ended = lineOf(lines, (e) => e.subtype === 'task_notification');
  assert.equal(results.length, 6);
  for (const i of results.filter((r) => r < ended)) assert.equal(stepAt(i, id).state, 'running', `after the reply at line ${i}`);
  assert.equal(stepAt(results[0], id).label, 'Watching: tick counter');
  assert.deepEqual(calls.jobs[0], {
    id: 'b8cg1m6u6',
    toolUseId: id,
    label: 'Watching: tick counter',
    command: 'for i in 1 2 3 4 5; do sleep 3; echo tick $i; done',
    outputFile: null,
    state: 'running',
  });
  assert.equal(stepAt(ended, id).state, 'done');
  assert.deepEqual(calls.jobs.at(-1), { id: 'b8cg1m6u6', state: 'done' });
});

test('#129: a Bash call moved to the background at its timeout is a job too, and a killed one ends as stopped', () => {
  const { calls, lines, stepAt } = replay('background-moved');
  const id = 'toolu_0124CkAxvQzXXDA4rhJ6RWjr';
  const result = lineOf(lines, (e) => e.type === 'result');
  assert.equal(stepAt(result, id).state, 'running');
  assert.equal(stepAt(result, id).job, 'bj3x41w3l');
  assert.equal(calls.jobs[0].id, 'bj3x41w3l');
  assert.match(calls.jobs[0].outputFile, /tasks\/bj3x41w3l\.output$/);
  assert.deepEqual(calls.jobs.at(-1), { id: 'bj3x41w3l', state: 'stopped' });
});

test('#129: a Monitor job’s Stop finds its tool shell by its command, as a Bash job’s does', async () => {
  const procs = parsePs(readFileSync(new URL('fixtures/claude-code/monitor-ps.txt', import.meta.url), 'utf8'));
  /** @type {[number, string|number][]} */
  const sent = [];
  const kill = (pid, sig) => {
    sent.push([pid, sig]);
    return true;
  };
  // Postbox starts the CLI in a group of its own; here timeout(1) led the group, as Postbox’s spawn does.
  const pgid = await stopJobUnder(
    { pid: 26615 },
    { command: 'for i in 1 2 3 4 5; do sleep 3; echo tick $i; done' },
    { kill, list: async () => procs, graceMs: 1 },
  );
  assert.equal(pgid, 26799);
  assert.deepEqual(sent[0], [-26799, 'SIGINT']);
});

test('#129: a result that only quotes a background id, such as a file the agent read, isn’t a job', () => {
  const lines = fixture('monitor');
  const start = lineOf(lines, (e) => e.type === 'user' && e.message.content.some?.((b) => b.tool_use_id === 'toolu_01GEVsa5H5sFq2QqAzmdh4fZ'));
  const quoted = 'notes.md: {"content":"Monitor started (task b8cg1m6u6, expires in 1m. Command running in background with ID: bx1."}';
  const read = [
    { type: 'assistant', message: { id: 'm_r', content: [{ type: 'tool_use', id: 'tu_read', name: 'Grep', input: { pattern: 'Monitor started' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_read', content: quoted }] } },
  ];
  const { calls, steps } = replay('', [...lines.slice(0, start), ...read]);
  assert.deepEqual(
    calls.jobs.map((j) => j.id),
    [],
    'only the Monitor call’s own result would start a job, and it isn’t in this replay',
  );
  assert.equal(steps().find((s) => s.id === 'tu_read').state, 'done');
});
