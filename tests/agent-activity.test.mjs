// What an agent’s subagents and background tools are doing (#73, #129), from streams recorded on claude 2.1.296:
// - subagent-tree.jsonl: a Reader subagent that narrates, thinks, runs Bash and starts a nested subagent, then a
//   Sleeper started in the background (recorded for #73 on 23 October 2026, Haiku, local paths removed);
// - monitor.jsonl and monitor-ps.txt: a Monitor call that runs past five replies, and its tool shell (recorded for
//   #129 on 23 October 2026);
// - background-moved.jsonl: a Bash call moved to the background at its timeout, cut from the HotpotQA UAT of
//   22 October 2026 (uat-runs/2026-10-22T01-02-09-hotpotqa, @critic’s stream 1792631182753);
// - background-subagent.jsonl: one Agent call with run_in_background whose subagent runs `sleep 20 && echo done`,
//   recorded for #189 on 23 October 2026 by the reviewing session, with the adapter’s flags on Haiku at low effort
//   (claude -p --output-format stream-json --include-partial-messages --verbose --thinking-display summarized
//   --forward-subagent-text --model haiku --effort low --strict-mcp-config --setting-sources project,local
//   --permission-mode auto), local paths removed;
// - ledger-push.jsonl (claude 2.1.309): an Agent call without run_in_background that Claude Code ran in the background.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { parsePs, stopJobUnder } from '../server/adapters/process-group.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

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

const READER = 'toolu_013QwF8b4BbQQRLaUtAMTt8v';
const NESTED = 'toolu_014cQVtisPCNL6gRibMij5jM';
const SLEEPER = 'toolu_01Fx9gH439KFimLB3aJUqnq7';

test('#73: a subagent’s narration is a step in its own voice, under its name, and never joins the reply', () => {
  const { calls, steps } = replay('subagent-tree');
  const said = steps().filter((s) => s.kind === 'said');
  const reader = said.filter((s) => s.parent === READER);
  assert.equal(reader[0].label, "I'll count the words in the test string with Bash to get the first result.");
  assert.ok(reader.every((s) => s.who === 'general-purpose' && s.state === 'done'));
  // Its whole text is kept: the first sentence is the label, the rest is there to open.
  assert.match(reader[1].detail, /^The word count came back as 3\. Next I'll start the nested checker/);
  assert.equal(reader[1].label, 'The word count came back as 3.');
  // Each subagent’s, the nested one’s and the background one’s too.
  assert.ok(said.some((s) => s.parent === NESTED && /echo nested-ok/.test(s.label)));
  assert.ok(said.some((s) => s.parent === SLEEPER && /sleeps for 25 seconds/.test(s.label)));
  assert.doesNotMatch(calls.text, /count the words in the test string|sleeps for 25 seconds/, 'a subagent’s text isn’t the agent’s reply');
});

test('#73: a subagent’s summarized thinking is kept whole as its own thought, apart from what it said', () => {
  const { steps } = replay('subagent-tree');
  const thoughts = steps().filter((s) => s.kind === 'thought' && s.parent === READER);
  assert.equal(thoughts.length, 3);
  assert.equal(thoughts[0].who, 'general-purpose');
  assert.match(thoughts[0].detail, /^I'll start by counting words with a quick bash command, then spin up a nested subagent/);
  // Before #73 only its first sentence survived, as the ring’s “doing” line.
  assert.ok(thoughts[0].detail.length > 120);
  assert.ok(!steps().some((s) => s.kind === 'said' && /spin up a nested subagent/.test(s.detail ?? '')), 'thinking isn’t narration');
});

test('#73: the activity list is a tree: each step points at the subagent call that made it, at any depth', () => {
  const { steps } = replay('subagent-tree');
  const all = steps();
  const byId = new Map(all.map((s) => [s.id, s]));
  // The Reader is the agent’s; its Bash call and its own subagent are under it; the nested one’s Bash is under that.
  assert.equal(byId.get(READER).kind, 'agent');
  assert.equal(byId.get(READER).parent, undefined);
  assert.equal(all.find((s) => s.label === 'Count words in test string').parent, READER);
  assert.equal(byId.get(NESTED).parent, READER);
  assert.equal(byId.get(NESTED).kind, 'agent');
  assert.equal(all.find((s) => s.label === 'Echo nested-ok test string').parent, NESTED);
  // A refused step points at the subagent that took it: the Sleeper’s blocked call fails under the Sleeper.
  const blocked = all.find((s) => s.label === 'Sleep 25 seconds then echo slept');
  assert.equal(blocked.parent, SLEEPER);
  assert.equal(blocked.state, 'failed');
  // A subagent’s step ends with what it returned.
  assert.match(byId.get(NESTED).detail, /nested-ok/);
});

test('#73: the session’s subagents say what each was asked, what it’s doing now, and which one started it', () => {
  const { lines, subsAt } = replay('subagent-tree');
  const bash = lineOf(lines, (e) => e.type === 'assistant' && e.message.content.some((b) => b.type === 'tool_use' && b.name === 'Bash'));
  const [reader] = subsAt(bash);
  assert.equal(reader.id, READER);
  assert.equal(reader.asked, 'Reader');
  assert.equal(reader.said, "I'll count the words in the test string with Bash to get the first result.");
  assert.equal(reader.state, 'tool');
  assert.equal(reader.doing, 'Count words in test string');
  const nestedStarts = lineOf(lines, (e) => e.subtype === 'task_started' && e.tool_use_id === NESTED);
  const nested = subsAt(nestedStarts).find((x) => x.id === NESTED);
  assert.equal(nested.parent, READER);
  assert.equal(nested.asked, 'Nested checker');
});

test('#73 element 4, reproduced: a subagent working in the background stays listed and running until its task ends', () => {
  const { lines, subsAt, stepAt } = replay('subagent-tree');
  // Claude Code answers the Sleeper’s call at once (“Async agent launched”); it works on for another 37 lines, until its
  // task_notification. Before, that answer ended its step as done and dropped it from the subagents.
  const launched = lineOf(lines, (e) => e.type === 'user' && e.message.content.some?.((b) => b.tool_use_id === SLEEPER));
  const said = lineOf(lines, (e) => e.parent_tool_use_id === SLEEPER && e.type === 'assistant');
  const ended = lineOf(lines, (e) => e.subtype === 'task_notification' && e.tool_use_id === SLEEPER);
  assert.ok(launched < said && said < ended);
  assert.equal(stepAt(launched, SLEEPER).state, 'running');
  assert.equal(stepAt(launched, SLEEPER).detail, 'Working in the background');
  const sleeper = subsAt(said).find((x) => x.id === SLEEPER);
  assert.equal(sleeper.bg, true);
  assert.match(sleeper.said, /sleeps for 25 seconds/);
  assert.equal(stepAt(ended, SLEEPER).state, 'done');
  assert.match(stepAt(ended, SLEEPER).detail, /The command was blocked/);
  assert.ok(!subsAt(ended).some((x) => x.id === SLEEPER));
  // The nested subagent the Reader started outlives the Reader, and stays listed until it ends.
  const readerDone = lineOf(lines, (e) => e.type === 'user' && e.message.content.some?.((b) => b.tool_use_id === READER));
  assert.ok(subsAt(readerDone).some((x) => x.id === NESTED));
});

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

test('#73: a background subagent’s own calls run on past a result, and one stopped ends as stopped', () => {
  const lines = fixture('subagent-tree');
  const bash = lineOf(lines, (e) => e.parent_tool_use_id === SLEEPER && e.type === 'assistant' && e.message.content.some((b) => b.type === 'tool_use'));
  const result = lines.find((e) => e.type === 'result');
  const stopped = { type: 'system', subtype: 'task_notification', task_id: 'ad3a80dec35d0bfde', tool_use_id: SLEEPER, status: 'stopped' };
  const { steps } = replay('', [...lines.slice(0, bash + 1), result, stopped]);
  const all = steps();
  // The reply’s result came while the Sleeper’s sleep ran: that call isn’t done.
  assert.equal(all.find((s) => s.label === 'Sleep 25 seconds then echo slept').state, 'running');
  const sleeper = all.find((s) => s.id === SLEEPER);
  assert.equal(sleeper.state, 'stopped');
  // Its notification had no summary: it says how it ended, not “Working in the background”.
  assert.equal(sleeper.detail, 'Stopped in the background');
});

for (const [name, id] of [
  ['background-subagent', 'toolu_01HFxPBV7hB6m5y1ZFJvnrZm'],
  ['ledger-push', 'toolu_0188wCgq2ycdLwABw51ZYX6m'],
])
  test(`#189: a subagent Claude Code runs in the background stays listed from launch to its task_notification (${name})`, () => {
    const { lines, subsAt, stepAt } = replay(name);
    const launched = lineOf(lines, (e) => e.type === 'user' && e.message.content.some?.((b) => b.tool_use_id === id));
    const ended = lineOf(lines, (e) => e.subtype === 'task_notification' && e.tool_use_id === id);
    assert.ok(launched > 0 && ended > launched);
    for (let i = launched; i < ended; i++)
      assert.ok(
        subsAt(i).some((x) => x.id === id && x.bg),
        `listed after line ${i}`,
      );
    assert.equal(stepAt(ended - 1, id).state, 'running');
    assert.ok(!subsAt(ended).some((x) => x.id === id));
    assert.equal(stepAt(ended, id).state, 'done');
  });

test('#189: the agent’s ring keeps its own state and step while its background subagent works', async () => {
  const lines = fixture('background-subagent');
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({
      name: 'mock',
      async folderFor() {
        return null;
      },
      async deliver(_session, _message, ctx) {
        const m = createStreamMapper(ctx);
        for (const e of lines) {
          m.push(e);
          seen.push({ ...store.state.sessions[se.id] });
        }
      },
    }),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  /** @type {any[]} */
  const seen = [];
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const p = rt.createPersona({ handle: 'developer' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  rt.sendMessage(t.id, { text: 'start a background subagent' });
  for (let i = 0; i < 200 && seen.length < lines.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen.length, lines.length);
  // The subagent’s own call, “Sleep 20 seconds then echo done”, never becomes the agent’s step.
  assert.ok(!seen.some((x) => x.currentStep === 'Sleep 20 seconds then echo done'), JSON.stringify(seen.map((x) => x.currentStep)));
  const sub = lineOf(lines, (e) => e.parent_tool_use_id && e.type === 'assistant');
  // Its reply is written, and it says it waits on its subagent: that call doesn’t make it “calling tools”.
  assert.equal(seen[sub].currentStep, 'Waiting for a background subagent');
  // And the subagent stays listed, apart from the agent, until it ends.
  const ended = lineOf(lines, (e) => e.subtype === 'task_notification' && e.tool_use_id === 'toolu_01HFxPBV7hB6m5y1ZFJvnrZm');
  assert.ok(seen.slice(sub, ended).every((x) => x.subagents.some((y) => y.bg)));
  assert.ok(!seen[ended].subagents.length);
});
