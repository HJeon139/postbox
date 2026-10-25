// The runner’s host mode (#120), as its options say it: which hosts, their settings, and where each agent runs.
//
//   --host <ssh destination>              repeatable; the hosts are host1, host2… in the order given
//   --host-setting <hostN>.<key>=<value>  a host setting (shared/remote-settings.mjs), such as host1.claudePath=/…/claude
//                                          or host2.idleTimeout=1min; keepAlive’s as keepAlive.interval and keepAlive.count
//   --place <handle>=<hostN|local>        where an agent runs, over the scenario’s `- place:` line
//
// Host names come only from these options, never from the repo. This pass is Claude Code only, so a run with a host
// refuses a scenario with an agent on another backend. Pure, so tests can feed it options.

import { checkDestination, checkHostSettings } from '../../shared/remote-settings.mjs';
import { forHosts } from './hosts-scenario.mjs';
import { compatBackends } from './scenario.mjs';

/** Scenarios host mode refuses by name: Codex’s, and the rooms with a Kiro or an Antigravity agent. */
export const NOT_ON_HOSTS = ['codex', 'mixedroom', 'geminiroom'];
const UNITS = { ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000, days: 86_400_000 };

/**
 * A setting’s value as written after the =: true, false, null, a JSON list, a whole number of milliseconds or bytes,
 * a duration with its unit (90s, 1min, 2h, 7d), or else text, such as a path.
 * @param {string} raw
 */
export function settingValue(raw) {
  const v = String(raw).trim();
  if (v === 'true' || v === 'false') return v === 'true';
  if (v === 'null') return null;
  if (v.startsWith('[')) {
    try {
      return JSON.parse(v);
    } catch {
      throw new Error(`--host-setting: “${v}” isn’t a JSON list, such as ["klist","-s"].`);
    }
  }
  const m = /^(\d+(?:\.\d+)?)(ms|s|min|h|d|days)?$/.exec(v);
  if (m) return Math.round(Number(m[1]) * UNITS[m[2] ?? 'ms']);
  return v;
}

/**
 * Host mode’s options, for the runner’s parseArgs: hosts as ssh destinations (host1, host2… in order), their settings
 * as hostN.key=value, and where agents run, as handle=hostN or handle=local over the scenario’s `- place:`.
 */
export const HOST_OPTIONS = {
  host: { type: 'string', multiple: true },
  'host-setting': { type: 'string', multiple: true },
  place: { type: 'string', multiple: true },
};

/** One `hostN.key=value`, checked against the hosts given. @param {string} spec @param {number} count */
function settingOf(spec, count) {
  const m = /^host(\d+)\.([\w.]+)=(.*)$/s.exec(String(spec));
  if (!m) throw new Error(`--host-setting takes hostN.key=value, such as host1.idleTimeout=1min, not “${spec}”.`);
  const n = Number(m[1]);
  if (n < 1 || n > count) throw new Error(`--host-setting ${spec}: there’s no host${n}; this run has ${count === 1 ? 'one --host' : `${count} hosts`}.`);
  const [key, sub] = m[2].split('.');
  const value = settingValue(m[3]);
  return { n, patch: sub ? { [key]: { [sub]: value } } : { [key]: value } };
}

/**
 * The hosts the options name, each with its settings checked as the server checks them.
 * @param {{ host?: string[], 'host-setting'?: string[] }} opt
 * @returns {{ label: string, destination: string, settings: Record<string, any> }[]}
 */
export function hostsOf(opt) {
  const hosts = (opt.host ?? []).map((d, i) => {
    const r = checkDestination(d);
    if (!r.ok) throw new Error(`--host “${d}”: ${r.error}`);
    return { label: `host${i + 1}`, destination: r.value, settings: {} };
  });
  if (new Set(hosts.map((h) => h.destination)).size !== hosts.length) throw new Error('--host names the same destination twice.');
  if (!hosts.length && opt.place?.length) throw new Error('--place puts an agent on a host, and this run has no --host.');
  for (const spec of opt['host-setting'] ?? []) {
    if (!hosts.length) throw new Error('--host-setting needs a --host to set it on.');
    const { n, patch } = settingOf(spec, hosts.length);
    const h = hosts[n - 1];
    const merged = patch.keepAlive ? { ...h.settings, keepAlive: { ...h.settings.keepAlive, ...patch.keepAlive } } : { ...h.settings, ...patch };
    const r = checkHostSettings(merged);
    if (!r.ok) throw new Error(`--host-setting ${spec}: ${r.error}`);
    h.settings = merged;
  }
  return hosts;
}

/**
 * Why a run with hosts can’t take this scenario, or null: this pass is Claude Code only.
 * @param {string} name  the scenario’s file name @param {{ backends: Record<string, { backend: string }> }} scenario
 */
export function refusal(name, scenario) {
  const other = compatBackends(scenario);
  if (!NOT_ON_HOSTS.includes(name) && !other.length) return null;
  return `--host runs Claude Code agents only, and ${other.length ? `this scenario puts agents on ${other.join(' and ')}` : `“${name}” needs a CLI other than Claude Code`}. Run it without --host, or pick a Claude-only scenario such as remotehosts, p0 or workroom.`;
}

/**
 * Where each of the scenario’s agents runs: its `- place:` line, then --place over it; agents neither names run here.
 * Every place must be a host the run has, and every --place an agent of the scenario’s.
 * @param {{ agents: string[], place?: Record<string, string> }} scenario @param {string[]} places  --place
 * @param {number} count  how many hosts @returns {Record<string, string>}
 */
export function placementOf(scenario, places, count) {
  /** @type {Record<string, string>} */
  const out = Object.fromEntries(scenario.agents.map((h) => [h, scenario.place?.[h] ?? 'local']));
  for (const spec of places ?? []) {
    const m = /^@?([\w-]+)=(host\d+|local)$/.exec(String(spec).trim());
    if (!m) throw new Error(`--place takes handle=hostN or handle=local, such as researcher=host1, not “${spec}”.`);
    if (!scenario.agents.includes(m[1]))
      throw new Error(`--place ${spec}: @${m[1]} isn’t one of this scenario’s agents (${scenario.agents.map((h) => `@${h}`).join(', ')}).`);
    out[m[1]] = m[2];
  }
  for (const [h, p] of Object.entries(out)) {
    const n = p === 'local' ? 0 : Number(p.slice(4));
    if (n > count || (p !== 'local' && n < 1))
      throw new Error(
        `@${h} is placed on ${p}, and this run has ${count === 1 ? 'one --host' : `${count} hosts`}. Give another --host, or --place ${h}=host1 or ${h}=local.`,
      );
  }
  return out;
}

/** The labels of hosts no agent is placed on, which the run sets up all the same. @param {Record<string, string>} placement @param {{ label: string }[]} hosts */
export const unplaced = (placement, hosts) => hosts.map((h) => h.label).filter((l) => !Object.values(placement).includes(l));

/**
 * The run’s host mode from its options: its hosts, where each agent runs, and the scenario as the run plays it. A
 * run without --host gets the scenario as it is, and no hosts.
 * @param {Record<string, any>} opt @param {string} name  the scenario’s file name @param {any} scenario
 */
export function hostMode(opt, name, scenario) {
  const hosts = hostsOf(opt);
  if (!hosts.length) return { hosts, placement: {}, scenario };
  const refused = refusal(name, scenario);
  if (refused) throw new Error(refused);
  const placement = placementOf(scenario, opt.place ?? [], hosts.length);
  return { hosts, placement, scenario: forHosts(scenario, placement, hosts) };
}
