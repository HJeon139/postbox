// #852 slice 1a r3’s grant tests share this: a room in Ask mode whose gh runs are recorded, its confirm, and the
// calls of a turn as the stream shows them, each ending ran (Postbox ran it), card, or denied.

import { createHash } from 'node:crypto';
import { confirmBodies } from '../server/confirm-body.mjs';
import { cards, setup, until } from './requested-setup.mjs';

export const LABEL = 'gh pr edit 896 --repo o/r --add-label "ready for integrator"';
export const sha = (s) => createHash('sha256').update(s).digest('hex');
export const theConfirm = (s) => s.store.items(s.t.id).find((i) => i.kind === 'block' && i.block.type === 'confirm');
export const block = (commands, statement = 'Confirming labels the PR.') => ({
  id: 'push',
  type: 'confirm',
  version: 1,
  fallback: 'Label it?',
  title: 'Label #896',
  statement,
  confirmLabel: 'Label #896',
  commands,
});
let n = 0;
/** A Bash call as the stream shows it and permission_prompt passes it on: bound, with its tool_use id. */
export const call = (command, extra = {}) => ({ tool: 'Bash', summary: 'run a command', input: { command }, bound: true, toolUseId: `tu${++n}`, ...extra });

/** One turn's calls, in order: the stream shows each, then it asks; a card is answered no. Gives each `allow`. */
function calling(s, reqs, answers, before = () => {}) {
  return async (c) => {
    await before(c);
    for (const req of reqs) {
      if (req.toolUseId && !req.unseen) c.toolUse({ id: req.toolUseId, name: req.tool, input: req.input });
      const k = cards(s).length;
      const asked = c.askPermission(req);
      const r = await Promise.race([asked, until(() => cards(s).length > k).then(() => null)]);
      if (r) answers.push(outcome(r));
      else {
        await s.rt.act(s.t.id, cards(s).at(-1).id, 'deny', {});
        await asked;
        answers.push('card');
      }
    }
  };
}
/** The agent shows the confirm, its body files read as an MCP call reads them (#852); then the person answers it. */
export async function confirmed(s, b, reqs = [], answer = 'confirm', { unrevised = false, before } = {}) {
  s.next.push(async (c) => c.tools.show_block({ block: b }, await confirmBodies(s.rt, s.rt.sessionsIn(s.t.id)[0].id, 'show_block', { block: b })));
  s.rt.sendMessage(s.t.id, { text: 'Get it ready.' });
  await until(() => !s.rt.turns.size);
  const answers = [];
  s.next.push(calling(s, reqs, answers, before));
  await s.rt.act(s.t.id, theConfirm(s).id, answer, {}, unrevised ? undefined : (theConfirm(s).revision ?? 1));
  await until(() => answers.length === reqs.length && !s.rt.turns.size);
  return answers;
}
/** A later turn of the same agent, started with no message from the person (as a wake would), making these calls. */
export async function later(s, reqs, session = s.rt.sessionsIn(s.t.id)[0]) {
  const answers = [];
  s.next.push(calling(s, reqs, answers));
  s.rt.deliver(session.id, { kind: 'notice', text: 'Go on.' }, { threadId: session.threadId });
  await until(() => answers.length === reqs.length && !s.rt.turns.size);
  return answers;
}
/** What became of a call that got no card: Postbox ran it in the agent’s place, or (a push) made it. */
export function outcome(r) {
  if (r.allow) return 'allowed';
  return /^Postbox ran this/.test(r.message ?? '') ? 'ran' : 'denied';
}
/** A room in Ask mode whose gh runs are recorded, not made: each gives exit 0 and its argv as output. */
export async function ask() {
  const s = await setup({ permissionMode: 'ask' });
  // The project’s own repository, which a confirmed gh call must post to (#852 r3).
  s.store.emit('project', { ...s.store.state.projects.p1, pushUrl: 'https://github.com/o/r.git' });
  s.ran = [];
  s.rt.runGh = async (argv) => {
    s.ran.push(argv);
    return { status: 0, output: argv.join(' '), argv: [...argv], timedOut: false };
  };
  return s;
}
