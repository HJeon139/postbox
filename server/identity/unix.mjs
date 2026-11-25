// The local identity provider (#558, prototype): on a run on this computer, the person is the unix user Postbox runs
// as. Nothing is asked and nothing is proved beyond what the request gate already holds: Postbox listens on 127.0.0.1
// and a write carries the page’s token, so whoever reaches it is treated as the user it runs as, as before profiles.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';

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

/** @returns {import('./index.mjs').Principal} */
export function unixPrincipal() {
  const u = userInfo();
  return {
    provider: 'unix',
    issuer: `unix:${hostname()}`,
    subject: u.uid >= 0 ? String(u.uid) : u.username, // Windows has no uid
    username: u.username,
    name: fullName(u.username) ?? u.username,
  };
}
