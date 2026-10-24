// The allow-once scenario’s triggers (#238, tests/uat/e2e/scenarios/allowonce.md): a single command auto mode’s
// classifier refused, the retry Allow once made, and a chained command’s card. tools/uat/triggers.mjs adds them to
// TRIGGERS, and reads them the same way: deterministic predicates over the run’s facts. Each reads the refusal cards in
// the state, and the agents’ recorded streams for what Claude Code ran and how it allowed each call: a user event’s
// tool_result_meta[].permission_decision, such as { decision: 'accept', source: 'config', reason_type: 'rule' } for a
// call an allow rule let through, or reason_type 'classifier' for one auto mode’s classifier did (as the UAT runs of
// 23 and 24 October 2026 recorded for Postbox’s own tools and for Bash in auto mode). The retry’s also reads the
// project’s `.git/config`, which the scenario’s command changes, and the chained card’s reads the page (readUi).

import { readFileSync } from 'node:fs';
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
    const decided = new Map();
    let mode = null;
    for (const e of s.events ?? []) {
      if (e?.type === 'system' && e.subtype === 'init') mode = e.permissionMode ?? mode;
      if (e?.type === 'system' && e.subtype === 'permission_denied') denied.add(e.tool_use_id);
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
            decision: decided.get(b.id) ?? null,
          });
        }
  }
  return out;
}

/** git remote add’s options that take a value (git-remote(1)): -t <branch> and -m <master>. */
const VALUED = new Set(['-t', '-m', '--track', '--master']);

/**
 * What a `git remote add [options] <name> <url>` did to the project’s repository: whether its `.git/config` names that
 * remote with that url. Null for another command, which the scenario doesn’t ask for. It throws when it can’t read the
 * config, so the run says it can’t tell rather than that the change didn’t happen.
 * @param {any} f  @param {{ threadId: string }} card  @param {string} command
 * @returns {boolean|null}
 */
export function remoteAdded(f, card, command) {
  const words = command.trim().split(/\s+/);
  if (words.slice(0, 3).join(' ') !== 'git remote add') return null;
  const args = [];
  for (let i = 3; i < words.length; i++)
    if (VALUED.has(words[i])) i++;
    else if (!words[i].startsWith('-')) args.push(words[i].replace(/^(['"])(.*)\1$/, '$2'));
  const [name, url] = args;
  if (!name || !url) return false;
  const folder = f.state?.projects?.[f.state?.threads?.[card.threadId]?.projectId]?.folder;
  if (!folder) throw new Error(`the conversation’s project has no folder, so the remote ${name} can’t be looked for`);
  const config = readFileSync(join(folder, '.git', 'config'), 'utf8');
  const section = config.split(/^(?=\[)/m).find((s) => s.startsWith(`[remote "${name}"]`)) ?? '';
  return section.split('\n').some((l) => l.trim() === `url = ${url}`);
}

export const ALLOW_ONCE_TRIGGERS = {
  'classifier-refused-single': {
    issue: 238,
    says: 'auto mode’s classifier refused a single command, and its card offered Allow once with that exact command as the rule',
    recorded: (f) => !!f.state,
    run: (f) =>
      cards(f)
        .filter((c) => c.reasonType === 'classifier' && !chains(c.detail) && c.rules?.once === `Bash(${c.detail.trim()})`)
        .map((c) => ({
          at: Number.isFinite(c.at) ? c.at : null,
          evidence: `Auto mode’s classifier refused @${c.handle}’s \`${clip(c.detail, 100)}\` (“${clip(c.reason, 100)}”), and the card offered \`${clip(c.rules.once, 110)}\`.`,
        })),
  },
  'allow-once-retry-ran': {
    issue: 238,
    says: 'after Allow once, the agent ran the byte-identical command in auto mode, Claude Code let it through by the allow rule (not the classifier), it ran with no error, and a git remote add’s remote is in the project',
    recorded: (f) => !!f.state && Array.isArray(f.streams),
    run: (f) => {
      const calls = bashCalls(f.streams);
      return cards(f)
        .filter((c) => c.status === 'allowed-once' && c.rules?.once && Number.isFinite(c.answeredAt))
        .flatMap((c) => {
          const retry = calls.find(
            (k) => k.handle === c.handle && k.id !== c.toolUseId && k.command === c.detail && (k.started ?? -1) >= c.answeredAt && k.mode === 'auto',
          );
          if (!retry?.result || retry.result.error || retry.denied) return [];
          // The rule Allow once passes covers only the next turn, so a call it let through is that turn’s. Without the
          // decision in the stream, the run can’t tell the rule from the classifier, which may clear it on the notice.
          if (!retry.decision) throw new Error(`the stream doesn’t say how Claude Code allowed \`${clip(retry.command, 80)}\``);
          if (retry.decision.decision !== 'accept' || retry.decision.reason_type !== 'rule') return [];
          const changed = remoteAdded(f, c, retry.command);
          if (changed === false) return [];
          const effect = changed ? ' The project’s .git/config has the remote it added.' : ' Its effect wasn’t checked: it isn’t a git remote add.';
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
