// The setup the request tests share (#296): a Claude Code agent whose turns a test scripts, a judge that answers as
// told, and helpers for the calls of a turn and the lines and cards they leave. Moved out of tests/write-intent.test.mjs.

import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const until = async (ok) => {
  for (let i = 0; i < 200 && !ok(); i++) await sleep(5);
};

export const bash = (command, extra = {}) => ({ tool: 'Bash', summary: 'run a command', input: { command }, ...extra });
export const CREATE = bash(`gh pr create --title "feat(now): what each agent is doing now" --body "$(cat <<'EOF'\n## Why\n\nCloses #508.\nEOF\n)"`);
export const confirm = (statement) => ({
  id: 'push',
  type: 'confirm',
  version: 1,
  fallback: 'Push?',
  title: 'Push Now',
  statement,
  confirmLabel: 'Push 2d7c9a65',
});
export const allow = (quote, costUsd = 0.0004) => ({ text: JSON.stringify({ decision: 'allow', quote }), costUsd });

/** A Claude Code agent whose turns the test scripts, and a judge that answers with `judged`. */
export async function setup({ judged = () => allow('open the PR') } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pb-requested-'));
  const folder = join(root, 'work');
  await mkdir(join(folder, '.claude'), { recursive: true });
  const store = new Store(null);
  const next = [];
  const adapter = {
    name: 'claude-code',
    folderFor: async () => folder,
    async deliver(_s, _m, ctx) {
      await (next.shift() ?? (async (c) => c.text('ok')))(ctx);
    },
  };
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://x', imageOrigins: [], lintSettleMs: 0, home: root },
  });
  const prompts = [];
  rt.judge = async (prompt) => {
    prompts.push(prompt);
    return judged(prompt);
  };
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'now', backend: 'claude-code', permissionMode: 'auto', tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  return { rt, store, t, p, next, prompts, folder };
}
export const cards = (s) => s.store.items(s.t.id).filter((i) => i.kind === 'permission');
export const lines = (s) => s.store.items(s.t.id).filter((i) => i.kind === 'allowedcall');

/** The calls of one turn, in order: each runs without a card, or its card is answered no. */
export function asking(s, reqs, answers) {
  return async (c) => {
    for (const req of reqs) {
      const n = cards(s).length;
      const asked = c.askPermission(req);
      const r = await Promise.race([asked, until(() => cards(s).length > n).then(() => null)]);
      if (r) answers.push(r);
      else {
        await s.rt.act(s.t.id, cards(s).at(-1).id, 'deny', {});
        answers.push(await asked);
      }
    }
  };
}
/** A turn the person’s message starts, whose agent asks for each call in turn. */
export async function asks(s, text, reqs) {
  const answers = [];
  s.next.push(asking(s, reqs, answers));
  s.rt.sendMessage(s.t.id, { text });
  await until(() => answers.length === reqs.length && !s.rt.turns.size);
  return answers.map((a) => a.allow);
}
/** The agent shows a block, the person answers it, and the turn that starts makes the calls. */
export async function afterBlock(s, block, answer, reqs) {
  s.next.push(async (c) => c.tools.show_block({ block }));
  s.rt.sendMessage(s.t.id, { text: 'Get Now ready to merge.' });
  await until(() => !s.rt.turns.size);
  const it = s.store.items(s.t.id).find((i) => i.kind === 'block');
  const answers = [];
  s.next.push(asking(s, reqs, answers));
  await s.rt.act(s.t.id, it.id, ...answer);
  await until(() => answers.length === reqs.length && !s.rt.turns.size);
  return answers.map((a) => a.allow);
}
