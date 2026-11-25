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
    u = { uid: process.getuid?.() ?? -1, username: process.env.USER || process.env.USERNAME || 'you' };
  }
  // Windows has no uid. The issuer names no computer: its name changes with the network, and the person doesn’t.
  return {
    provider: 'unix',
    issuer: 'unix:this-computer',
    subject: u.uid >= 0 ? String(u.uid) : u.username,
    username: u.username,
    name: fullName(u.username) ?? u.username,
  };
}
