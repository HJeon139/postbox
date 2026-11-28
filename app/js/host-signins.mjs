// Whether a host’s harness is signed in (#1608), as the host last said (hostStatus.signIns, from its daemon’s run of
// the harness’s own status command), for the host’s card in the Hosts tab and the “Runs on” field: a sign-out is found
// before work is handed to an agent there, not when a turn fails.

import { LOGIN_COMMANDS } from '/shared/remote-protocol-constants.mjs';
import { client } from './client.mjs';

/**
 * A harness’s sign-in on a host, as the host last said: 'signed-in', 'signed-out' or 'unknown' (it couldn’t tell), or
 * null before it said. Only a sign-out warns: the status reports stored credentials and can be wrong.
 * @param {string} hostId @param {string} harness @returns {string | null}
 */
export function signInOf(hostId, harness) {
  const said = client.state.hostStatus?.[hostId]?.signIns?.harnesses;
  const x = Array.isArray(said) ? said.find((/** @type {any} */ y) => y?.name === harness) : null;
  return x?.state ?? null;
}

/** The command that signs a harness in on its host, or null for one without. @param {string} harness */
export const loginCommand = (harness) => (Object.hasOwn(LOGIN_COMMANDS, harness) ? LOGIN_COMMANDS[harness] : null);
