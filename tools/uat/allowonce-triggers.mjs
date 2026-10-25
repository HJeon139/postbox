// The allow-once scenario’s triggers (#238, tests/uat/e2e/scenarios/allowonce.md): a single command auto mode’s
// classifier refused, the retry Allow once made, and a chained command’s card. tools/uat/triggers.mjs adds them to
// TRIGGERS, and reads them the same way: deterministic predicates over the run’s facts. Each reads the refusal cards in
// the state, and the agents’ recorded streams for what Claude Code ran and how it decided each call: a user event’s
// tool_result_meta[].permission_decision, such as { decision: 'accept', source: 'config', reason_type: 'rule' } for a
// call an allow rule let through, or reason_type 'classifier' for one auto mode’s classifier did (as the UAT runs of
// 23 and 24 October 2026 recorded for Postbox’s own tools and for Bash in auto mode), and a permission_denied event’s
// decision_reason_type for a refused one. The retry’s also compares what it printed with the fake .env the scenario
// seeds (`- seed: fake-env`), and the chained card’s reads the page (readUi).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chains } from '../../server/command-chains.mjs';
import { clip, itemsOf, resultText } from './trigger-facts.mjs';

const blocks = (e) => (Array.isArray(e?.message?.content) ? e.message.content : []);
const cards = (f) => itemsOf(f).filter((it) => it.kind === 'denial' && it.tool === 'Bash');

/**
 * Every Bash call in the recorded streams: its exact command, its turn’s permission mode (from the stream’s init),
 * its result, whether Claude Code refused it, and how Claude Code decided it (null when the stream doesn’t say).
 * @param {{ handle: string, started?: number, events: any[] }[]} streams
 */
export function bashCalls(streams) {
  const out = [];
  for (const s of streams ?? []) {
    const results = new Map();
    const denied = new Set();
    const deniedBy = new Map();
    const decided = new Map();
    let mode = null;
    for (const e of s.events ?? []) {
      if (e?.type === 'system' && e.subtype === 'init') mode = e.permissionMode ?? mode;
      if (e?.type === 'system' && e.subtype === 'permission_denied') {
        denied.add(e.tool_use_id);
        deniedBy.set(e.tool_use_id, e.decision_reason_type ?? null);
      }
      if (e?.type === 'result') for (const d of e.permission_denials ?? []) denied.add(d?.tool_use_id);
      if (e?.type === 'user') for (const b of blocks(e)) if (b?.type === 'tool_result') results.set(b.tool_use_id, b);
      if (e?.type === 'user') for (const m of e.tool_result_meta ?? []) if (m?.permission_decision) decided.set(m.id, m.permission_decision);
    }
    for (const e of s.events ?? [])
      if (e?.type === 'assistant')
        for (const b of blocks(e)) {
          if (b?.type !== 'tool_use' || b.name !== 'Bash' || typeof b.input?.command !== 'string') continue;
          const r = results.get(b.id);
          out.push({
            handle: s.handle,
            id: b.id,
            command: b.input.command,
            started: Number.isFinite(s.started) ? /** @type {number} */ (s.started) : null,
            mode,
            result: r ? { error: r.is_error === true, text: resultText(r) } : null,
            denied: denied.has(b.id),
            deniedBy: deniedBy.get(b.id) ?? null,
            decision: decided.get(b.id) ?? null,
          });
        }
  }
  return out;
}

/** The fake value the scenario’s .env holds: obviously not a secret, made by the run, and never anywhere else. */
export const FAKE_VALUE = 'uat-not-a-secret';

/**
 * `- seed: fake-env`: a .env in the project, and one in its folder sub, each with the fake value. The runner writes
 * them before the agents start, so the classifier, which reads the person’s messages and the commands an agent runs
 * but not their output, sees only a read of a .env.
 * @param {string} workspace  the run’s project folder
 */
export function seedFakeEnv(workspace) {
  mkdirSync(join(workspace, 'sub'), { recursive: true });
  for (const dir of [workspace, join(workspace, 'sub')]) writeFileSync(join(dir, '.env'), `API_TOKEN=${FAKE_VALUE}\n`);
}

/** Whether a recorded call is one auto mode’s classifier refused: its permission_denied, or its decision, says so. */
const refusedByClassifier = (k) => k?.deniedBy === 'classifier' || (k?.decision?.decision === 'reject' && k.decision.reason_type === 'classifier');
/** The recorded call a refusal card is for, when its stream says the classifier refused it. */
const classifierRefusal = (calls, c) => calls.find((k) => k.handle === c.handle && k.id === c.toolUseId && refusedByClassifier(k));

export const ALLOW_ONCE_TRIGGERS = {
  'classifier-refused-single': {
    issue: 238,
    says: 'auto mode’s classifier refused a single command, by its card and its stream, and its card offered Allow once with that exact command as the rule',
    recorded: (f) => !!f.state && Array.isArray(f.streams),
    run: (f) => {
      const calls = bashCalls(f.streams);
      return cards(f)
        .filter((c) => c.reasonType === 'classifier' && !chains(c.detail) && c.rules?.once === `Bash(${c.detail.trim()})`)
        .filter((c) => classifierRefusal(calls, c))
        .map((c) => ({
          at: Number.isFinite(c.at) ? c.at : null,
          evidence: `Auto mode’s classifier refused @${c.handle}’s \`${clip(c.detail, 100)}\` (“${clip(c.reason, 100)}”), by its card and its stream, and the card offered \`${clip(c.rules.once, 110)}\`.`,
        }));
    },
  },
  'allow-once-retry-ran': {
    issue: 238,
    says: 'after Allow once on the classifier’s refusal, the agent ran the byte-identical command in auto mode, Claude Code let it through by the allow rule (not the classifier), it ran with no error, and a read of the seeded .env printed its fake value',
    recorded: (f) => !!f.state && Array.isArray(f.streams),
    run: (f) => {
      const calls = bashCalls(f.streams);
      return cards(f)
        .filter((c) => c.status === 'allowed-once' && c.rules?.once && Number.isFinite(c.answeredAt) && classifierRefusal(calls, c))
        .flatMap((c) => {
          const retry = calls.find(
            (k) => k.handle === c.handle && k.id !== c.toolUseId && k.command === c.detail && (k.started ?? -1) >= c.answeredAt && k.mode === 'auto',
          );
          if (!retry?.result || retry.result.error || retry.denied) return [];
          // The rule Allow once passes covers only the next turn, so a call it let through is that turn’s. Without the
          // decision in the stream, the run can’t tell the rule from the classifier, which may clear it on the notice.
          if (!retry.decision) throw new Error(`the stream doesn’t say how Claude Code allowed \`${clip(retry.command, 80)}\``);
          if (retry.decision.decision !== 'accept' || retry.decision.reason_type !== 'rule') return [];
          // A read of the seeded .env prints its fake value; another command’s effect isn’t this scenario’s to check.
          const read = /\.env\b/.test(retry.command) ? retry.result.text.includes(FAKE_VALUE) : null;
          if (read === false) return [];
          const effect = read ? ' It printed the fake value the run seeded.' : ' Its effect wasn’t checked: it doesn’t read the .env.';
          return [
            {
              at: retry.started,
              evidence: `@${c.handle} ran \`${clip(retry.command, 100)}\` again, byte for byte, after Allow once, in auto mode: Claude Code allowed it by a rule, and it exited without an error.${effect}`,
            },
          ];
        });
    },
  },
  'chained-refusal-no-allow': {
    issue: 238,
    says: 'a chained command was refused, and its card offered neither Allow once nor Always allow, and said why',
    recorded: (f) => !!f.state && !!f.ui?.denialCards,
    run: (f) =>
      cards(f)
        .filter((c) => chains(c.detail) && !c.rules?.once && !c.rules?.always)
        .filter((c) => {
          const shown = f.ui?.denialCards?.[c.id];
          return (
            shown &&
            shown.buttons.length > 0 &&
            !shown.buttons.some((b) => /Allow once|Always allow/i.test(b)) &&
            /checks each part of a chained command/.test(shown.text) &&
            /separate commands/.test(shown.text)
          );
        })
        .map((c) => ({
          at: Number.isFinite(c.at) ? c.at : null,
          evidence: `@${c.handle}’s \`${clip(c.detail, 100)}\` was refused; its card offered only ${f.ui.denialCards[c.id].buttons.map((b) => `“${b}”`).join(', ')}, and said Claude Code checks each part of a chained command on its own.`,
        })),
  },
};
