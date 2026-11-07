// #852 slice 1a's UAT triggers (tools/uat/triggers.mjs has what a trigger is): a command the person confirmed ran with
// no second card, and the same command run again got its card. Read from the room's items as the run records them:
// the allowed-call line Postbox writes for a confirmed command (server/confirm-grant.mjs), and the permission cards.
// The scenario pushes to a bare repository the runner makes beside the workspace (`- seed: bare-remote`), so nothing
// leaves the machine.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { itemsUnderTest } from './remote-facts.mjs';
import { clip } from './trigger-facts.mjs';

/** An allowed-call line for a command the person confirmed, under this rule (it names the confirm). */
const confirmedLine = (it) => it.kind === 'allowedcall' && it.how === 'confirmed' && typeof it.blockItemId === 'string';

/** A card’s command: its input’s, since a write’s card keeps its detail for the draft. */
const commandOf = (it) => it.input?.command ?? it.detail;

/** `- seed: bare-remote`: one commit in the workspace, and `origin`, a bare repository beside it. */
export function seedBareRemote(workspace) {
  const remote = join(workspace, '..', 'uat-remote.git');
  const git = (...args) => spawnSync('git', args, { stdio: 'ignore' });
  git('init', '-q', '--bare', remote);
  git('-C', workspace, '-c', 'user.name=UAT', '-c', 'user.email=uat@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Start');
  git('-C', workspace, 'remote', 'add', 'origin', remote);
}

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const CONFIRM_TRIGGERS = {
  'confirmed-command-ran': {
    issue: 852,
    says: 'a command the person confirmed ran with no second card',
    recorded: (f) => !!f.state,
    run: (f) =>
      itemsUnderTest(f)
        .filter(confirmedLine)
        .map((it) => ({
          at: Number.isFinite(it.at) ? it.at : null,
          evidence: `@${it.handle} ran “${clip(it.detail, 80)}”, as confirmed (${clip(it.approved, 40)}).`,
        })),
  },
  'confirmed-command-carded-again': {
    issue: 852,
    says: 'running a confirmed command a second time asked the person again',
    recorded: (f) => !!f.state,
    run: (f) => {
      const items = itemsUnderTest(f);
      const ran = items.filter(confirmedLine);
      return items
        .filter((it) => it.kind === 'permission' && ran.some((r) => r.threadId === it.threadId && r.detail === commandOf(it) && (r.at ?? 0) <= (it.at ?? 0)))
        .map((it) => ({ at: Number.isFinite(it.at) ? it.at : null, evidence: `The same command again got a card: “${clip(commandOf(it), 80)}”.` }));
    },
  },
};
