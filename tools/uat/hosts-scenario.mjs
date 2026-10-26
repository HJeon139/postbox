// A scenario as a host-mode run plays it (#120; tools/uat/scenario.mjs has the syntax): a phase whose agent (`- host:`)
// runs on a host takes its host triggers and its “On a host” text, and the tester is told where each agent runs and
// what it may break on purpose. A run without hosts plays the scenario as it is.

/** What the tester may do in a host run only, besides the usual actions. */
const FAULTS = `This run puts agents on other machines, reached over ssh, so you can break things on purpose, as the phase asks:
- fault {fault, target}: kill-ssh (kill Postbox’s ssh connection to target, host1 or host2), kill-daemon (kill Postbox’s daemon on target), or restart-postbox (stop Postbox and start it again on the same data; no target). The run tells you what Postbox showed after, and waits until the host reads Connected again or 3 minutes pass.
- To do one while a turn runs, give send, thread, act or review an interrupt {after, do: fault, fault, target}.`;

/**
 * @param {any} scenario  parseScenario’s @param {Record<string, string>} placement  hosts-options.mjs’s placementOf
 * @param {{ label: string, destination: string }[]} hosts
 */
export function forHosts(scenario, placement, hosts) {
  if (!hosts.length) return scenario;
  const away = (h) => Boolean(h && placement[h] && placement[h] !== 'local');
  const where = Object.entries(placement)
    .map(([h, p]) => `@${h} ${p === 'local' ? 'on this computer' : `on ${p} (${hosts.find((x) => x.label === p)?.destination ?? p})`}`)
    .join(', ');
  return {
    ...scenario,
    phases: scenario.phases.map((ph) =>
      away(ph.host) ? { ...ph, triggers: ph.hostTriggers?.length ? ph.hostTriggers : ph.triggers, text: ph.hostText || ph.text } : ph,
    ),
    summary: `${scenario.summary}\n\nWhere the agents run: ${where}. A host’s name in Postbox is its ssh destination.\n\n${FAULTS}`,
  };
}
