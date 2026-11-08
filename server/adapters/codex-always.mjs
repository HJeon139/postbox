// What Always allow offers on a Codex command card (#324): exactly the amendment Codex itself proposed with the
// request (`proposedExecpolicyAmendment`, a command prefix, or `proposedNetworkPolicyAmendments`, a host), answered as
// Codex’s own decision, so Codex saves the rule in its own rules and Postbox writes none. Never a wider rule than
// Codex proposed, and none that would allow any program (#281’s rule), so the person’s one click can’t grant more than
// the command they saw. The person decided this on 25 October 2026.

import { networkOn } from './codex-network.mjs';

/**
 * First words whose job is to run whatever follows them, so “commands starting with” one would allow any program
 * (#281’s rule). A new wrapper belongs here when that’s what it does.
 */
const RUNS_ANOTHER = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'pwsh',
  'env',
  'sudo',
  'xargs',
  'time',
  'nice',
  'nohup',
  'timeout',
  'watch',
  'command',
  'exec',
  'eval',
  'ssh',
  'docker',
  'python',
  'python3',
  'node',
  'perl',
  'ruby',
  'php',
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'make',
]);
/**
 * Tools whose first word alone covers every subcommand, `git push --force` with `git status`: they need a second word,
 * and it must be the subcommand, not an option.
 */
const SUBCOMMANDS = new Set(['git', 'gh', 'cargo', 'go', 'kubectl', 'brew', 'apt', 'apt-get', 'pip', 'pip3', 'uv', 'rustup', 'gcloud', 'aws', 'az']);
/** A shell operator, substitution or redirect inside a word: such a prefix isn’t a plain command. */
const OPERATOR = /[;&|<>`$()\n\\]/;

/** Whether a proposed prefix is one Always allow may offer. @param {unknown} prefix */
function plainPrefix(prefix) {
  if (!Array.isArray(prefix) || !prefix.length) return false;
  if (!prefix.every((w) => typeof w === 'string' && w && !OPERATOR.test(w))) return false;
  if (RUNS_ANOTHER.has(prefix[0])) return false;
  if (!SUBCOMMANDS.has(prefix[0])) return true;
  // The second word must be a subcommand: an option such as git -c or -C can make the tool run any program.
  return prefix.length >= 2 && !prefix[1].startsWith('-');
}

/**
 * The card’s Always allow for a Codex command request, or null for none. A network stop offers its host, unless the
 * persona is in Auto without web access: one click would undo “personas without web access stay offline”.
 * @param {any} params  the request’s params @param {any} persona
 * @returns {{ lines: { text: string, rule: string }[], updates: { type: 'codex', decision: any }[], harness: true } | null}
 */
export function codexAlwaysOffer(params, persona) {
  const offer = (text, rule, decision) => ({
    lines: [{ text, rule }],
    updates: [{ type: /** @type {const} */ ('codex'), decision }],
    harness: /** @type {const} */ (true),
  });
  if (params?.networkApprovalContext) {
    const host = (Array.isArray(params.proposedNetworkPolicyAmendments) ? params.proposedNetworkPolicyAmendments : []).find(
      (a) => a?.action === 'allow' && typeof a.host === 'string' && a.host && !OPERATOR.test(a.host),
    )?.host;
    const offline = (persona?.permissionMode ?? 'auto') === 'auto' && !networkOn(persona);
    if (!host || offline) return null;
    return offer(`Always allow network access to ${host}, as a Codex rule`, host, {
      applyNetworkPolicyAmendment: { network_policy_amendment: { host, action: 'allow' } },
    });
  }
  const prefix = params?.proposedExecpolicyAmendment;
  if (!plainPrefix(prefix)) return null;
  const rule = prefix.join(' ');
  return offer(`Always allow commands starting with ${rule}, as a Codex rule`, rule, { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...prefix] } });
}
