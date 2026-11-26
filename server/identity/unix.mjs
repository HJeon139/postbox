// The local identity provider (#558): on a run on this computer, the person is the account Postbox runs as. Nothing
// is asked and nothing is proved beyond what the request gate already holds: Postbox listens on 127.0.0.1 and a write
// carries the page’s token, so whoever reaches it is treated as that account, as before there were people.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';

/** The account’s full name, where the system has one: macOS’s `id -F`, or the GECOS field of /etc/passwd. */
function fullName(/** @type {string} */ username) {
  try {
    if (process.platform === 'darwin') return execFileSync('id', ['-F'], { encoding: 'utf8', timeout: 2000 }).trim() || null;
    const line = readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${username}:`));
    return line?.split(':')[4]?.split(',')[0]?.trim() || null;
  } catch {
    return null; // no such tool or file (Windows, a directory service): the username stands in
  }
}

/** The account Postbox runs as, as a principal. @returns {import('./index.mjs').Principal} */
export function unixAccount({ info = userInfo } = {}) {
  let u;
  try {
    u = info();
  } catch {
    // An account the system has no entry for (a container started with a bare uid): Postbox still starts.
    u = { username: process.env.USER || process.env.USERNAME || 'you' };
  }
  // On a run on this computer the data folder is the Postbox, and whoever opens it is its one person (`sole`): the
  // same folder opened by another account (another computer, a container, sudo, a service account) is still theirs.
  // So nothing of the account is who they are: not the computer’s name, which changes with the network, and not the
  // uid, which changes with the account. The login and full name are what the account calls them, a default to change.
  return {
    provider: 'unix',
    issuer: 'unix:this-computer',
    subject: 'the-person',
    sole: true,
    username: u.username,
    name: fullName(u.username) ?? u.username,
  };
}
