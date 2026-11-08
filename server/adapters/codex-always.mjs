// What Always allow offers on a Codex command card (#324): exactly the amendment Codex itself proposed with the
// request (`proposedExecpolicyAmendment`, a command prefix, or `proposedNetworkPolicyAmendments`, a host), answered as
// Codex’s own decision, so Codex saves the rule and Postbox writes none. The person decided this on 25 October 2026.
//
// What such a rule does, read in Codex’s source at rust-v0.167.0 (codex-rs/core/src/exec_policy.rs): a command whose
// every part matches an allow rule runs with no approval and outside the sandbox (:467–469, Skip { bypass_sandbox }),
// and the rule goes in <codex home>/rules/default.rules (:904–905), so it holds for every Codex session on this
// computer, in every mode. Nothing judges a matching command after the click, so the card says so, and Always allow
// offers only a prefix whose program is on a short list of ones that read and print: never a wider rule than Codex
// proposed, and nothing to a persona that may not fetch the web, since a matching command runs with network.
//
// It’s a list of programs to allow, not to refuse: three rounds of refusing names each missed some that run any
// program (other shells, launchers, runtimes, `git submodule foreach`, a name in capitals on macOS). A redirect or a
// substitution can’t turn one of these into a write: Codex matches a script word by word only when it has neither
// (codex-rs/shell-command/src/bash.rs :22–29, :410–413), and otherwise matches it whole, as `bash -lc …`
// (exec_policy.rs :913–943), which no rule here starts with.

import { networkOn } from './codex-network.mjs';

/**
 * Programs that read and print, and whose options name no program to run or file to write, as the first word, exactly
 * (`LS` isn’t `ls`, though macOS would run it). `rg` (--pre), `sort` (--compress-program), `find`, `diff` (-l runs pr),
 * `tree` (-o) and `uniq` (an output file) aren’t, and nor is git, whose config can name a program for status, diff or
 * log in a folder the agent chose.
 */
const READS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'stat',
  'du',
  'df',
  'pwd',
  'which',
  'echo',
  'cut',
  'basename',
  'dirname',
  'realpath',
  'whoami',
  'uname',
]);
/** gh commands that read: the two words after `gh`. A built-in command can’t be an alias, so these run as they say. */
const GH_READS = new Set(['pr view', 'pr list', 'pr diff', 'pr checks', 'issue view', 'issue list', 'run view', 'run list']);
/** A shell operator, substitution or redirect inside a word: such a prefix isn’t a plain command. */
const OPERATOR = /[;&|<>`$()\n\\]/;
/** A host as Codex names one: labels of letters, digits and hyphens joined by dots, with a letter, so no wildcard, no
 * bare address and no single name such as localhost. */
const HOST = /^(?=.*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
/** The longest rule a card shows: one longer isn’t cut short, since a shorter prefix would allow more. */
const RULE_MAX = 120;

/** Whether a proposed prefix is one Always allow may offer. @param {unknown} prefix */
function plainPrefix(prefix) {
  if (!Array.isArray(prefix) || !prefix.length) return false;
  if (!prefix.every((w) => typeof w === 'string' && w && !OPERATOR.test(w))) return false;
  if (prefix.join(' ').length > RULE_MAX) return false;
  if (READS.has(prefix[0])) return true;
  return prefix[0] === 'gh' && prefix.length >= 3 && GH_READS.has(`${prefix[1]} ${prefix[2]}`);
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
