// #558's UAT trigger (tools/uat/triggers.mjs has what a trigger is): an agent was told who the person says they are.
// Read from what each agent was given, as its transcript records it: a prompt that carries the turn's part about the
// person. A run that never saved a profile never fires it, so it reads as a gap in coverage, not a pass. Whether the
// agent then used it is the tester's to judge.

import { inputsOf } from './room-delivery.mjs';
import { clip } from './trigger-facts.mjs';

const HEAD = '[Postbox] About the person, in their own words:';

/** Every prompt an agent was given in the run, with whose it was. @param {any} f */
const prompts = (f) =>
  [...new Set((f.transcripts ?? []).map((/** @type {any} */ t) => t.handle))].flatMap((handle) =>
    (inputsOf(f, handle) ?? []).filter((x) => x.kind === 'prompt').map((x) => ({ ...x, handle })),
  );

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const PROFILE_TRIGGERS = {
  // What Postbox sent, not what the agent answered: an agent’s harness may know the person anyway, from the
  // workspace’s git user or the computer’s account, whatever Postbox tells it.
  'profile-untold-before-save': {
    issue: 558,
    says: 'before the person saved a profile, no turn told an agent anything of them',
    recorded: (f) => Array.isArray(f.transcripts) && f.transcripts.length > 0 && Array.isArray(f.probes?.profiles),
    run: (f) => {
      const saved = Math.min(...(f.probes?.profiles ?? []).map((/** @type {any} */ p) => p.at).filter(Number.isFinite));
      const before = prompts(f).filter((x) => x.at < saved);
      if (!before.length || before.some((x) => x.text.includes(HEAD))) return [];
      const whom = [...new Set(before.map((x) => `@${x.handle}`))].join(', ');
      return [
        {
          at: Math.max(...before.map((x) => x.at)),
          evidence: `${before.length} ${before.length === 1 ? 'turn' : 'turns'} to ${whom} before the first save, and none had a part about the person.`,
        },
      ];
    },
  },
  'profile-told': {
    issue: 558,
    says: 'a turn told an agent who the person says they are, from a profile they saved',
    recorded: (f) => Array.isArray(f.transcripts) && f.transcripts.length > 0,
    run: (f) =>
      prompts(f)
        .filter((x) => x.text.includes(HEAD))
        .map((x) => ({
          at: Number.isFinite(x.at) ? x.at : null,
          evidence: `@${x.handle} was told: “${clip(
            x.text
              .slice(x.text.indexOf(HEAD) + HEAD.length)
              .trim()
              .split('\n\n')[0]
              .replace(/\n/g, ' '),
            120,
          )}”.`,
        })),
  },
};
