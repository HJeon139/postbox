// The automatic installs a host-mode run saw (#464): Postbox installs its own version on a host by itself, once per
// version, when the person’s consent is on and the host can’t run that version (server/remote/hosts-update.mjs). The
// run keeps each host status event with its newest install try (tools/uat/history.mjs, hostStateOf) in its record
// of its hosts, as statuses (tools/uat/hosts-run.mjs, followStatuses). A try is its version and when it started: its
// status says started, then how it ended, and comes again with every other change of the host’s status.

import { labelOf } from './remote-facts.mjs';

/** The outcomes of a try that ran an install, or was running one. */
const RAN = new Set(['started', 'installed']);

/**
 * Each install try of a host the statuses show, by version, then by when it started: the outcomes it showed, each
 * with when its status first came. @param {any} f @param {string} id
 * @returns {Map<string, Map<number, Map<string, number>>>}
 */
export function triesOf(f, id) {
  const out = new Map();
  for (const s of f.hosts?.statuses ?? []) {
    const u = s?.update;
    if (s?.id !== id || typeof u?.version !== 'string' || !Number.isFinite(u.at) || typeof u.outcome !== 'string') continue;
    if (!out.has(u.version)) out.set(u.version, new Map());
    const tries = out.get(u.version);
    if (!tries.has(u.at)) tries.set(u.at, new Map());
    if (!tries.get(u.at).has(u.outcome)) tries.get(u.at).set(u.outcome, s.at);
  }
  return out;
}

/** A host’s tries of one version that showed one of these outcomes. @param {Map<number, Map<string, number>>} tries @param {Set<string>} outcomes */
export const triesWith = (tries, outcomes) => [...(tries ?? new Map()).values()].filter((t) => [...t.keys()].some((o) => outcomes.has(o)));

/**
 * Postbox installed one version on one host by itself more than once: it tries a version once (hosts-update.mjs,
 * isTried), so a second try that ran is a loop, whatever made the host fail again after the first.
 */
export const INSTALL_CHECKS = [
  {
    id: 'auto-install-repeated',
    issue: 464,
    run: (f) =>
      [...new Set((f.hosts?.statuses ?? []).map((s) => s?.id))].flatMap((id) =>
        [...triesOf(f, id)].flatMap(([version, tries]) => {
          const ran = triesWith(tries, RAN).length;
          if (ran < 2) return [];
          const label = labelOf(f, id) ?? 'a host';
          return [
            {
              key: `${label}:${version}`,
              title: `Postbox installed ${version} on ${label} by itself ${ran} times`,
              evidence: `Its status showed ${ran} install tries of ${version} that started or installed, where Postbox tries a version once.`,
            },
          ];
        }),
      ),
  },
];
