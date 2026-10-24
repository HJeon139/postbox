// What the telemetry tests share (designs/telemetry-persona.md, “Acceptance”): a project folder with planted canaries,
// a room of two agents whose turns stream Claude Code lines through the adapters’ shared recorder, a data folder of its
// own for the recordings, and a stub classifier that records what it was sent.

import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { recorderFor } from '../server/adapters/setup.mjs';
import { startRecording, watchTelemetry } from '../server/telemetry.mjs';
import { makeReport, readDraft } from '../server/telemetry-report.mjs';
import { setup as base, settle } from './side-threads-fixture.mjs';

/** Canaries no model or word list knows, so one in a report can only have come from the room. */
export const CANARIES = {
  key: 'AKIAQX7Z4KLMN2PQ8RWT',
  path: 'src/zorvex_cfg/loader_qa.py',
  fn: 'quillmorph_settings_v7',
  email: 'brannoch.pell@zorvex-internal.example',
  repo: 'https://github.com/zorvex-corp/private-quillmorph',
  phrase: 'the velvet tramontane ledger stays sealed tonight',
};

/** Every file under a folder, relative to it. */
export function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}
/** A path’s permission bits, as 0o700 and 0o600 are written. */
export const modeOf = (p) => statSync(p).mode & 0o777;

/** One Claude Code turn’s stream: a command that prints the .env, its output, and the turn’s cost. */
export const streamLines = (command = 'cat .env') => [
  { type: 'system', subtype: 'init', session_id: 'cs-1', model: 'claude-haiku-5-5', tools: ['Bash'] },
  {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command } }], usage: { output_tokens: 20 } },
  },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: `AWS_ACCESS_KEY_ID=${CANARIES.key}\nOWNER=${CANARIES.email}` }] } },
  { type: 'result', usage: { input_tokens: 100, output_tokens: 40 }, total_cost_usd: 0.002, permission_denials: [] },
];

/** A scripted turn: streams its lines through the recorder every adapter uses, then replies. */
export const turn =
  (text, lines = streamLines()) =>
  async (c) => {
    const record = recorderFor(c, undefined, 'claude-code');
    for (const l of lines) record(JSON.stringify(l));
    c.text(text);
  };

/** Labels that pass the gate. */
export const GOOD = { mast: 'FM-3.2', area: 'checks', attribution: 'unsure', confidence: 'low' };
/** An answer that labels every ref it was asked about with these fields. */
export const labelEach =
  (fields = GOOD) =>
  (prompt) => ({ labels: [...prompt.matchAll(/<item for="([cr]\d+)">/g)].map((m) => ({ on: m[1], ...fields })) });

/**
 * A room of alpha and beta in a project with canaries, its own data folder, and a stub classifier: it records each
 * prompt it’s sent and answers with `answer(prompt)`, as JSON, or as it is when that’s a string.
 * @param {{ record?: boolean, answer?: (prompt: string) => any }} [opts]
 */
export function setup({ record = false, answer = () => ({ labels: [] }) } = {}) {
  const b = base();
  const folder = mkdtempSync(join(tmpdir(), 'pb-telemetry-project-'));
  mkdirSync(join(folder, 'src', 'zorvex_cfg'), { recursive: true });
  writeFileSync(join(folder, CANARIES.path), `def ${CANARIES.fn}():\n    return {}\n`);
  writeFileSync(join(folder, '.env'), `AWS_ACCESS_KEY_ID=${CANARIES.key}\nOWNER=${CANARIES.email}\nREMOTE=${CANARIES.repo}\n`);
  b.store.emit('project', { id: 'p1', name: 'P', folder });
  const data = mkdtempSync(join(tmpdir(), 'pb-telemetry-data-'));
  b.rt.config.telemetryRoot = join(data, 'telemetry');
  b.rt.config.build = { version: '0.21.0', commit: 'abc1234' };
  const prompts = [];
  b.rt.summarize = async (prompt) => {
    prompts.push(prompt);
    const a = answer(prompt);
    return { text: typeof a === 'string' ? a : JSON.stringify(a), costUsd: 0.001 };
  };
  const stop = watchTelemetry(b.rt);
  if (record) startRecording(b.rt, b.t.id);
  return { ...b, folder, data, prompts, stop };
}

/**
 * A recorded room where alpha ran a command that printed the .env and replied, and the person flagged the reply.
 * @param {Parameters<typeof setup>[0]} [opts]
 */
export async function flaggedRoom(opts = {}) {
  const f = setup({ record: true, answer: labelEach(), ...opts });
  f.adapter.next.push(turn('I ran the tests; one fails.'));
  f.rt.sendMessage(f.t.id, { text: `@alpha run the tests, then tell me ${CANARIES.phrase}` });
  await settle(f.rt);
  const reply = f.store.items(f.t.id).find((x) => x.kind === 'agent');
  f.rt.act(f.t.id, reply.id, '@react', { emoji: '🚩' });
  return { ...f, reply };
}

/** Makes a report on a room, and returns its draft. */
export async function report(f, opts = {}) {
  const { id } = await makeReport(f.rt, f.t.id, opts);
  return { id, draft: readDraft(f.rt, f.t.id, id) };
}

export { settle };
