// Grant once (#852): what the room-rule tests share. A room in Ask mode, as slice 1a’s confirm tests have it, whose
// gh runs and pushes are recorded, not made, with a repository in the agent’s folder read as files; the person’s
// “Allow always in this room” on a first card; and a rule saved directly, for the hostile suite.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ask, call, outcome } from './confirm-grant-fixture.mjs';
import { cards, until } from './requested-setup.mjs';

export { call, outcome };
export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);
export const REPO_URL = 'https://github.com/o/r.git';

/** A repository’s .git, as files: HEAD on `current`, and each branch at its commit. */
export async function gitFolder(folder, branches, current = Object.keys(branches)[0]) {
  await mkdir(join(folder, '.git', 'refs', 'heads', 'feat'), { recursive: true });
  await mkdir(join(folder, '.git', 'objects'), { recursive: true });
  await writeFile(join(folder, '.git', 'HEAD'), `ref: refs/heads/${current}\n`);
  for (const [branch, sha] of Object.entries(branches)) await writeFile(join(folder, '.git', 'refs', 'heads', branch), `${sha}\n`);
}

/**
 * The room: slice 1a’s Ask-mode room, with a repository in the agent’s folder, and pushes recorded. `main` is what the
 * remote says its default branch is (null: it can’t be read).
 */
export async function granting({ main = 'main' } = {}) {
  const s = await ask();
  await gitFolder(s.folder, { 'feat/a': SHA_A, 'feat/b': SHA_B });
  s.pushed = [];
  s.rt.pushes = {
    defaultBranch: async () => main,
    run: async (p) => {
      s.pushed.push({ branch: p.branch, sha: p.sha, url: p.url, lease: p.lease });
      return { ok: true };
    },
  };
  return s;
}

/** The session’s calls of one turn, each answered `answer` on its card if it gets one. Gives each one’s fate. */
export function turnOf(s, reqs, answer = 'deny') {
  const answers = [];
  return {
    answers,
    step: async (c) => {
      for (const req of reqs) {
        if (req.toolUseId && !req.unseen) c.toolUse({ id: req.toolUseId, name: req.tool, input: req.input });
        const k = cards(s).length;
        const asked = c.askPermission(req);
        const r = await Promise.race([asked, until(() => cards(s).length > k).then(() => null)]);
        if (r) answers.push(outcome(r) === 'denied' && /^Postbox pushed/.test(r.message ?? '') ? 'pushed' : outcome(r));
        else {
          await s.rt.act(s.t.id, cards(s).at(-1).id, answer, {});
          await asked;
          answers.push(answer === 'deny' ? 'card' : `card:${answer}`);
        }
      }
    },
  };
}

/** A turn of the room’s agent, started as a wake would start one, making these calls. */
export async function turn(s, reqs, { answer = 'deny', session = s.rt.sessionsIn(s.t.id)[0] } = {}) {
  const t = turnOf(s, reqs, answer);
  s.next.push(t.step);
  s.rt.deliver(session.id, { kind: 'notice', text: 'Go on.' }, { threadId: session.threadId });
  await until(() => t.answers.length === reqs.length && !s.rt.turns.size);
  return t.answers;
}

/** A rule, saved as the person’s answer would save it: for the hostile suite, which needs one in place. */
export function saveRule(s, shape, { personaId = s.p.id, hostId = null, threadId = s.t.id } = {}) {
  const room = s.store.state.threads[threadId];
  const grant = { id: `gr_${shape.replace(/\W/g, '')}`, personaId, handle: 'now', hostId, shape, at: Date.now() };
  s.rt.putThread({ ...room, grants: [...(room.grants ?? []), grant] });
  return grant;
}
