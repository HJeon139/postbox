// What Always allow offers on a permission card (server/permission-cards.mjs): the harness’s own suggestions, or the
// rule Postbox makes and saves itself, for this folder or for a host.

import { hostWhere } from './host-rules.mjs';
import { alwaysAllow, cleanRule, rulesFor } from './permission-rules.mjs';

/**
 * What Always allow offers on a card, or null for none:
 * - none when Claude Code says a saved rule would grant more than this call (the SDK’s suppressAlwaysAllowRule);
 * - Claude Code’s own suggestions when it sends a list (the SDK does, and an empty list means none);
 * - a harness’s own offer, `{ lines, updates, harness: true }`, as it is: the harness saves that rule itself, on this
 *   computer or a host (Codex’s, server/adapters/codex-always.mjs, #324);
 * - otherwise, for the CLI’s prompt tool, which sends no list at all (recorded), the rule Postbox makes for a refusal,
 *   which it saves where the CLI saves “don’t ask again”; but only for a backend that reads rules from a folder.
 * hostId: the host of the turn that asked, for a host prompt; where the rule is kept then, and what the card says.
 * @param {any} rt @param {any} se
 * @param {{ tool: unknown, input: any, suggestions: unknown, suppressAlways: boolean, hostId?: string | null }} req
 */
export function alwaysFor(rt, se, { tool, input, suggestions, suppressAlways, hostId = null }) {
  if (suppressAlways) return null;
  if (Array.isArray(suggestions)) return alwaysAllow(suggestions);
  if (isHarnessOffer(suggestions)) return suggestions;
  if (suggestions !== null && suggestions !== undefined) return null;
  const persona = rt.persona(se.personaId);
  // For a turn on a host, Postbox keeps the rule for that host (host-rules.mjs), and the card says so.
  return rt.readsRules(persona?.backend) ? postboxAlways(String(tool ?? '').slice(0, 121), input, hostWhere(rt, hostId)) : null;
}

/**
 * Always allow for a prompt without suggestions (the CLI’s prompt tool sends none): the broader rule a refusal card
 * offers (permission-rules.mjs, rulesFor), which Postbox saves in the folder’s local settings itself, or, for an agent on
 * a host, in its store for that host; where says so in words then.
 * @param {string} tool @param {any} input @param {string | null} [where]
 */
function postboxAlways(tool, input, where = null) {
  if (!tool || tool.length > 120) return null;
  const r = rulesFor(tool, input && typeof input === 'object' ? input : {});
  // A rule too long to keep, or none (a chained command, which no one rule can allow, #238), isn’t offered.
  if (!r.always || cleanRule(r.always) !== r.always) return null;
  return {
    updates: null,
    saves: r.always,
    lines: [{ text: `Always allow ${r.always} ${where ?? 'in this folder (.claude/settings.local.json)'}`, rule: r.always }],
    moved: null,
    words: r.alwaysWords,
  };
}

/** Whether suggestions are a harness’s own Always allow, which it saves itself (#324). @param {unknown} suggestions */
const isHarnessOffer = (suggestions) => typeof suggestions === 'object' && suggestions !== null && /** @type {any} */ (suggestions).harness === true;
