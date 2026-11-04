// The runner’s host mode (#120), as its options say it: which hosts, their settings, and where each agent runs.
//
//   --host <ssh destination>              repeatable; the hosts are host1, host2… in the order given
//   --host-setting <hostN>.<key>=<value>  a host setting (shared/remote-settings.mjs), such as host1.claudePath=/…/claude
//                                          or host2.idleTimeout=1min; keepAlive’s as keepAlive.interval and keepAlive.count
//   --place <handle>=<hostN|local>        where an agent runs, over the scenario’s `- place:` line
//   --stage-host-version <tag>            an older Postbox, a release tag here such as v1.16.1, staged on host1 before
//                                          the run in place of its Install (#464, tools/uat/hosts-stage.mjs)
//
// Host names come only from these options, never from the repo. This pass is Claude Code only, so a run with a host
// refuses a scenario with an agent on another backend. Pure, so tests can feed it options, and the checkout’s tags.

import { compareVersions } from '../../server/remote/host/cleanup-root.mjs';
import { checkDestination, checkHostSettings } from '../../shared/remote-settings.mjs';
import { forHosts } from './hosts-scenario.mjs';
import { TAG_RE } from './hosts-stage.mjs';
import { compatBackends } from './scenario.mjs';

/** A checkout with no tags, for a caller that gives none. */
const NO_TAGS = { current: () => '', versionAt: () => null };

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
  // Lets the run install over a Postbox already installed on a host, which its Remove at the end then deletes.
  'replace-host-install': { type: 'boolean', default: false },
  // An older Postbox staged on host1 before the run, as someone who updated Postbox here has on a host (#464).
  'stage-host-version': { type: 'string' },
};

/** The trigger a phase played with an older Postbox staged names, and only such a phase. */
export const STAGED_TRIGGER = 'host-staged-older';

/**
 * The older Postbox --stage-host-version stages, or null without it: a release tag of this checkout’s, whose package
 * version isn’t this checkout’s, for a run with a --host. Only host1 gets it: one host on the older version is what
 * the phase that needs it plays, and the others stay as the run installs them.
 * @param {{ 'stage-host-version'?: string, 'replace-host-install'?: boolean }} opt @param {number} count  how many hosts
 * @param {{ current: () => string, versionAt: (tag: string) => string|null }} repo  tools/uat/hosts-stage.mjs, tagRepo
 * @returns {{ tag: string, version: string } | null}
 */
export function stagedOf(opt, count, repo) {
  const tag = opt['stage-host-version'];
  if (tag === undefined) return null;
  if (!TAG_RE.test(tag)) throw new Error(`--stage-host-version takes a release tag, such as v1.16.1, not “${tag}”.`);
  if (!count) throw new Error('--stage-host-version stages Postbox on host1, and this run has no --host.');
  // The run’s cleanup deletes what it staged, which is safe only because baseline() refused a host where Postbox
  // already was; --replace-host-install lets such a host through, so the two don’t combine.
  if (opt['replace-host-install'] === true)
    throw new Error(
      '--stage-host-version and --replace-host-install don’t combine: the run deletes what it staged at its end, so it stages only on a host with no Postbox.',
    );
  const version = repo.versionAt(tag);
  if (!version) throw new Error(`--stage-host-version ${tag}: there’s no such tag in this checkout. Run git fetch --tags, or pick one git tag lists.`);
  if (compareVersions(version, repo.current()) >= 0)
    throw new Error(
      `--stage-host-version ${tag} is Postbox ${version}, not older than ${repo.current()}, the version this run installs. Pick an older tag, such as the release before it.`,
    );
  return { tag, version };
}

/**
 * Why a run can’t play these phases with what it stages, or null: a phase that names host-staged-older needs an older
 * Postbox staged, and one that doesn’t can’t take one, since host1’s turns would read not installed.
 * @param {{ phases: { title: string, triggers?: string[] }[] }} scenario @param {boolean} staged
 */
export function stageRefusal(scenario, staged) {
  const wrong = scenario.phases.filter((p) => (p.triggers ?? []).includes(STAGED_TRIGGER) !== staged).map((p) => `“${p.title}”`);
  if (!wrong.length) return null;
  return staged
    ? `--stage-host-version leaves host1 without this run’s Postbox, which ${wrong.join(' and ')} need${wrong.length > 1 ? '' : 's'}. Play only the phase that names ${STAGED_TRIGGER}, with --phases.`
    : `${wrong.join(' and ')} need${wrong.length > 1 ? '' : 's'} an older Postbox on host1. Pass --stage-host-version with an older tag, such as v1.16.1, or leave ${wrong.length > 1 ? 'them' : 'it'} out with --phases.`;
}

/**
 * The scenario without its phases that need an older Postbox staged: what a run without --stage-host-version plays when
 * it names no phases, so a plain run of remotehosts.md still plays the rest. Naming such a phase without the option is
 * still refused (stageRefusal). @param {{ phases: { triggers?: string[] }[] }} scenario
 */
export function withoutStaged(scenario) {
  return { ...scenario, phases: scenario.phases.filter((p) => !(p.triggers ?? []).includes(STAGED_TRIGGER)) };
}

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
 * @param {{ host?: string[], 'host-setting'?: string[], place?: string[], 'replace-host-install'?: boolean }} opt
 * @returns {{ label: string, destination: string, settings: Record<string, any>, replaceInstall: boolean }[]}
 */
export function hostsOf(opt) {
  const hosts = (opt.host ?? []).map((d, i) => {
    const r = checkDestination(d);
    if (!r.ok) throw new Error(`--host “${d}”: ${r.error}`);
    return { label: `host${i + 1}`, destination: r.value, settings: {}, replaceInstall: opt['replace-host-install'] === true };
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
 * run without --host gets the scenario as it is, and no hosts. host1 carries what --stage-host-version stages.
 * @param {Record<string, any>} opt @param {string} name  the scenario’s file name @param {any} scenario
 * @param {Parameters<typeof stagedOf>[2]} [repo]  the checkout’s tags, read only for --stage-host-version
 */
export function hostMode(opt, name, scenario, repo = NO_TAGS) {
  const hosts = hostsOf(opt);
  const stage = stagedOf(opt, hosts.length, repo);
  if (!hosts.length) return { hosts, placement: {}, scenario };
  // --phases chooses phases; --phase only says where to start, so it still drops the staged phase as a plain run does.
  if (!stage && opt.phases == null) scenario = withoutStaged(scenario);
  const refused = refusal(name, scenario) ?? stageRefusal(scenario, Boolean(stage));
  if (refused) throw new Error(refused);
  if (stage) Object.assign(hosts[0], { stage });
  const placement = placementOf(scenario, opt.place ?? [], hosts.length);
  return { hosts, placement, scenario: forHosts(scenario, placement, hosts) };
}
