// The P0 hotfixes' triggers (#108, #123, #125; tests/uat/e2e/scenarios/p0.md): what its first two phases are there to
// make Postbox show. tools/uat/triggers.mjs adds them to TRIGGERS, and says what a trigger is.

import { postboxCalls } from './postbox-calls.mjs';
import { clip, itemsOf } from './trigger-facts.mjs';

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const P0_TRIGGERS = {
  'wake-full-text': {
    issue: 108,
    says: 'an allowed wake delivered the agent’s whole message, longer than the request’s 200-character preview',
    recorded: (f) => !!f.state,
    run: (f) => {
      const items = itemsOf(f);
      return items
        .filter((it) => it.kind === 'hop' && it.status === 'allowed' && typeof it.text === 'string' && it.text.length > 200)
        .flatMap((hop) => {
          const got = items.find(
            (x) =>
              x.kind === 'agent' &&
              x.sessionId === hop.fromSessionId &&
              x.text === hop.text &&
              (x.at ?? 0) >= (hop.at ?? 0) &&
              f.state.threads?.[x.threadId]?.kind === 'side',
          );
          return got
            ? [
                {
                  at: Number.isFinite(got.at) ? got.at : null,
                  evidence: `@${hop.from}’s ${hop.text.length.toLocaleString('en-US')}-character message reached @${hop.to} whole once the wake was allowed.`,
                },
              ]
            : [];
        });
    },
  },
  'update-over-unread': {
    issue: 123,
    says: 'it refused update_block over an answer the agent hadn’t read yet',
    recorded: (f) => Array.isArray(f.streams),
    run: (f) =>
      postboxCalls(f.streams)
        .filter((c) => c.name === 'update_block' && /The person answered revision \d+ of .+ Their answer stays on screen/.test(c.text))
        .map((c) => ({
          at: c.at,
          evidence: `@${c.handle}’s update_block of “${clip(c.input?.block?.id ?? c.input?.id, 60)}” was refused: “${clip(c.text, 160)}”`,
        })),
  },
  'stale-answer': {
    issue: 123,
    says: 'it refused an answer from the person’s page because the block had changed since they read it',
    recorded: (f) => Array.isArray(f.probes?.stale),
    run: (f) =>
      (f.probes?.stale ?? []).map((p) => ({
        at: Number.isFinite(p.at) ? p.at : null,
        evidence: `The page refused the answer to ${p.key}: “${clip(p.text, 160)}”`,
      })),
  },
  'repeated-block-id': {
    issue: 125,
    says: 'it refused show_block for an id the agent already showed',
    recorded: (f) => Array.isArray(f.streams),
    run: (f) =>
      postboxCalls(f.streams)
        .filter((c) => c.name === 'show_block' && /^Block .+ is already shown\./.test(c.text))
        .map((c) => ({ at: c.at, evidence: `@${c.handle}’s show_block was refused: “${clip(c.text, 160)}”` })),
  },
};
