// What keeps a UAT run’s agents from changing the person’s real GitHub. A run’s agents read real conversations and do
// what they ask, and their shells inherit Postbox’s environment, so without this they have the person’s `gh` login and
// git credentials. `--file no` stops only the runner’s filing, and `- gh: none` only Postbox’s own File issue.
// Every run gets, unless its scenario says `- github: real`:
// - gh with no login: GH_CONFIG_DIR is a folder of the run’s, where nothing has signed in, and GH_TOKEN is a token GitHub
//   refuses (NO_TOKEN), which gh prefers over the keychain. A variable survives the agent’s login shell, which a wrapper
//   first on PATH doesn’t: a Mac profile puts Homebrew’s gh back first;
// - git refused every remote that isn’t a local path (guardEnv), whatever repository it runs in, so a real clone reached
//   by its absolute path is refused too, and no credential, the keychain’s included, is ever asked for. Local paths
//   stay allowed, so a local bare repository still takes a push.
// The runner’s own reading and filing (open-issues.mjs, review.mjs) run in the runner’s environment, not this one, so
// they keep the person’s login. A `- seed: git-remote` run gets this and more, from gitRemoteEnv.
// What’s left, so no one reads this as containment: the guard is environment, so an agent set on reaching GitHub can
// unset it (`env -u GH_TOKEN gh auth token`, `GIT_ALLOW_PROTOCOL=https git push …`). And it reaches only the agents on
// this computer: one on a `--host` machine has that machine’s gh and git.

import { spawnSync } from 'node:child_process';
import { guardEnv, NO_TOKEN, preflightRemote, remotePaths, tearDownRemote, UNREACHABLE } from './git-remote.mjs';

/**
 * The environment that takes the person’s GitHub away from a run’s Postbox and its agents, or nothing when the scenario
 * says `- github: real`. gh treats a config folder that isn’t there yet as one with no login.
 * @param {{ github?: string }} scenario @param {string} dir  the run’s folder
 * @returns {Record<string, string>}
 */
export function noGithubEnv(scenario, dir) {
  if (scenario.github === 'real') return {};
  return {
    ...guardEnv(),
    GH_CONFIG_DIR: remotePaths(dir).ghConfig,
    GH_TOKEN: NO_TOKEN,
    GITHUB_TOKEN: '',
    GH_ENTERPRISE_TOKEN: NO_TOKEN,
    GITHUB_ENTERPRISE_TOKEN: '',
  };
}

/**
 * Whether the guard holds in a shell like the agent’s, the person’s login shell, whose profile could undo it. Throws, so
 * the run stops, when gh there hands out any token but the run’s, or git isn’t refused https. The shell compares the
 * token itself, so a real one is never printed or kept, and asking for it doesn’t touch the network.
 * @param {Record<string, string|undefined>} env  the run’s environment
 */
function preflightNoGithub(env) {
  const stop = (what) => new Error(`${what}, so the run stops before any agent turn.`);
  const probe = `t=$(gh auth token 2>/dev/null); s=$?; if [ "$s" = 127 ] || [ "$t" = ${NO_TOKEN} ]; then echo gh-guarded; fi; t=; GIT_TERMINAL_PROMPT=0 git ls-remote ${UNREACHABLE} 2>&1`;
  const out = spawnSync(env.SHELL || '/bin/sh', ['-lic', probe], { env, encoding: 'utf8', timeout: 20_000 }).stdout ?? '';
  // 127 is no gh at all. No line means another token, or a shell that never got that far.
  if (!/^gh-guarded$/m.test(out)) throw stop('gh in the agent’s shell can still reach a GitHub login');
  if (!/transport 'https' not allowed/.test(out)) throw stop(`git in the agent’s shell isn’t refused an https remote (it said: ${out.trim().slice(-200)})`);
}

/**
 * Checks a run’s guards before Postbox starts, on env, the environment the runner gives Postbox, which the agents
 * inherit: a `- seed: git-remote` run’s (its gh is a fake, which answers every call), or every other run’s.
 * @param {{ seed: string|null, github?: string }} scenario @param {string} workspace @param {string} dir
 * @param {Record<string, string|undefined>} env
 */
export function preflightRun(scenario, workspace, dir, env) {
  if (scenario.seed === 'git-remote') {
    try {
      preflightRemote(workspace, dir, env);
    } catch (e) {
      // The run’s stop doesn’t exist yet, so nothing else would remove the remote this run seeded. The preflight’s reason
      // is what stops the run: a teardown that fails too only adds that the remote is still there.
      try {
        tearDownRemote(dir, () => {});
      } catch (left) {
        throw new Error(`${e.message} The run’s remote couldn’t be removed either: ${left.message}`, { cause: e });
      }
      throw e;
    }
  } else if (scenario.github !== 'real') preflightNoGithub(env);
}
