// What Always allow offers on a Codex command card (#324): exactly the amendment Codex itself proposed with the
// request (`proposedExecpolicyAmendment`, a command prefix, or `proposedNetworkPolicyAmendments`, a host), answered as
// Codex’s own decision, so Codex saves the rule and Postbox writes none. The person decided this on 25 October 2026.
//
// What such a rule does, read in Codex’s source at rust-v0.167.0 (codex-rs/core/src/exec_policy.rs): a command whose
// every part matches an allow rule runs with no approval and outside the sandbox (:467–469, Skip { bypass_sandbox }),
// and the rule goes in <codex home>/rules/default.rules (:904–905), so it holds for every Codex session on this
// computer, in every mode. Nothing judges a matching command after the click, so the card says so, and Always allow
// offers only what can’t run any program: never a wider rule than Codex proposed, never a prefix that would run
// another program (#281’s rule), and nothing to a persona that may not fetch the web, since a matching command runs
// with network.

import { networkOn } from './codex-network.mjs';

/**
 * First words whose job is to run whatever follows them, or that run a program their options name, compared with any
 * version suffix taken off (python3.12 is python). A new one belongs here when that’s what it does. It’s a list of
 * programs to refuse, so it can’t be complete (vim, less and man run one through !, git through an alias): what the
 * person sees before clicking is the exact prefix, and that the rule runs outside Codex’s sandbox.
 */
const RUNS_ANOTHER = new Set([
  ...['bash', 'sh', 'zsh', 'fish', 'pwsh', 'env', 'sudo', 'xargs', 'time', 'nice', 'nohup', 'timeout', 'watch'],
  ...['source', 'command', 'exec', 'eval', 'ssh', 'docker', 'osascript', 'make', 'find', 'awk', 'sed', 'tar', 'rsync'],
  ...['python', 'node', 'perl', 'ruby', 'php', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'deno', 'uvx', 'tsx'],
]);
/**
 * Tools whose first word alone covers every subcommand, `git push --force` with `git status`: they need a second word,
 * and it must be a subcommand that runs no other program.
 */
const SUBCOMMANDS = new Set(['git', 'gh', 'cargo', 'go', 'kubectl', 'brew', 'apt', 'apt-get', 'pip', 'pipx', 'poetry', 'uv', 'rustup', 'gcloud', 'aws', 'az']);
/** Subcommands that run whatever program comes next: `uv run`, `cargo run`, `kubectl exec`, `gh extension`, `pipx run`, `dlx`. */
const RUNS_NEXT = new Set(['run', 'exec', 'x', 'dlx', 'extension']);
/** A shell operator, substitution or redirect inside a word: such a prefix isn’t a plain command. */
const OPERATOR = /[;&|<>`$()\n\\]/;
/** A host as Codex names one: letters, digits, dots and hyphens, so no wildcard and no space. */
const HOST = /^[a-z0-9.-]+$/i;
/** The longest rule a card shows: one longer isn’t cut short, since a shorter prefix would allow more. */
const RULE_MAX = 120;

/** A first word as a program’s name: its version suffix taken off (python3.12 → python). @param {string} word */
const programOf = (word) => word.replace(/[\d.]+$/, '');

/** Whether a proposed prefix is one Always allow may offer. @param {unknown} prefix */
function plainPrefix(prefix) {
  if (!Array.isArray(prefix) || !prefix.length) return false;
  if (!prefix.every((w) => typeof w === 'string' && w && !OPERATOR.test(w))) return false;
  if (prefix.join(' ').length > RULE_MAX) return false;
  // A path or an assignment as the first word names a program the list can’t see: /bin/sh, ./run.sh, FOO=bar node.
  if (/[/=]/.test(prefix[0])) return false;
  const program = programOf(prefix[0]);
  // A first word of only digits and dots names no program the lists can check: `.` runs a script, as `source` does.
  if (!program) return false;
  if (RUNS_ANOTHER.has(program)) return false;
  if (!SUBCOMMANDS.has(program)) return true;
  // The second word must be a subcommand: an option such as git -c can make the tool run any program.
  return prefix.length >= 2 && !prefix[1].startsWith('-') && !RUNS_NEXT.has(prefix[1]);
}

/** Where the rule goes and what it does, as the card says it. */
const WHERE = 'as a Codex rule: they run outside its sandbox, with no card, in every Codex session on this computer';

/**
 * The card’s Always allow for a Codex command request, or null for none.
 * @param {any} params  the request’s params @param {any} persona
 * @returns {{ lines: { text: string, rule: string }[], updates: { type: 'codex', decision: any }[], harness: true } | null}
 */
export function codexAlwaysOffer(params, persona) {
  const offer = (text, rule, decision) => ({
    lines: [{ text, rule }],
    updates: [{ type: /** @type {const} */ ('codex'), decision }],
    harness: /** @type {const} */ (true),
  });
  // Network is the one thing every offer gives: a host directly, and a prefix because a matching command runs
  // outside the sandbox. So a persona that may not fetch the web is offered neither, in any mode.
  const mayFetch = Array.isArray(persona?.tools) && persona.tools.includes('web.fetch');
  if (!mayFetch) return null;
  if (params?.networkApprovalContext) {
    // Outside Auto the sandbox is offline for every persona (networkOn), so a host rule would give network that
    // mode never has.
    if (!networkOn(persona)) return null;
    const proposed = Array.isArray(params.proposedNetworkPolicyAmendments) ? params.proposedNetworkPolicyAmendments : [];
    const host = proposed.find((a) => a?.action === 'allow' && typeof a.host === 'string' && HOST.test(a.host))?.host;
    if (!host) return null;
    return offer(`Always allow network access to ${host}, as a Codex rule, in every Codex session on this computer`, host, {
      applyNetworkPolicyAmendment: { network_policy_amendment: { host, action: 'allow' } },
    });
  }
  const prefix = params?.proposedExecpolicyAmendment;
  if (!plainPrefix(prefix)) return null;
  const rule = prefix.join(' ');
  return offer(`Always allow commands starting with ${rule}, ${WHERE}`, rule, { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...prefix] } });
}
