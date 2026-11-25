// Who a request is from (#558, prototype): one seam, `identify(req)`, behind which a provider proves a principal.
// The request gate (server/index.mjs) asks it once per request, after its Host, Origin and token checks, and everything
// past it reads the person it resolved to, never a name from the request’s body.
//
//   local  the unix user Postbox runs as (server/identity/unix.mjs). The default, and what a run on this computer is.
//   alb    an AWS Application Load Balancer’s signed header (server/identity/alb.mjs), for a run served to a team.
//
// A provider is a function from a request to a Principal, so another (AWS Verified Access’s x-amzn-ava-user-context,
// an OIDC code flow of Postbox’s own) is a module and a line in PROVIDERS. SAML is never parsed here: a hand-written
// XML signature check is the class of flaw “On Breaking SAML” (USENIX Security 2012) found in 11 of 14 frameworks, so
// a SAML provider federates through a Cognito user pool and reaches Postbox as OIDC claims.

import { albIdentity } from './alb.mjs';
import { unixPrincipal } from './unix.mjs';

/**
 * Who a provider proved. `issuer` and `subject` together are the key; the rest are hints a profile starts from.
 * @typedef {{ provider: string, issuer: string, subject: string, username: string, name: string, email?: string }} Principal
 */

const PROVIDERS = {
  local: () => {
    const me = unixPrincipal();
    return async () => me;
  },
  alb: (/** @type {NodeJS.ProcessEnv} */ env) =>
    albIdentity({
      signer: env.POSTBOX_ALB_SIGNER ?? '',
      region: env.POSTBOX_ALB_REGION,
      // A stand-in balancer’s key address, for the demo and tests. It is refused unless it’s on this computer.
      keyUrl: env.POSTBOX_ALB_KEYS ? localKeys(env.POSTBOX_ALB_KEYS) : undefined,
    }),
};

function localKeys(/** @type {string} */ base) {
  const url = new URL(base);
  if (url.hostname !== '127.0.0.1') throw new Error('POSTBOX_ALB_KEYS is for a stand-in balancer on 127.0.0.1 only. Leave it unset to read AWS’s keys.');
  return (/** @type {string} */ kid) => new URL(kid, url).href;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ mode: 'local' | 'alb', identify: (req: import('node:http').IncomingMessage) => Promise<Principal> }}
 */
export function createIdentity(env = process.env) {
  const mode = env.POSTBOX_IDENTITY ?? 'local';
  if (mode !== 'local' && mode !== 'alb') throw new Error(`POSTBOX_IDENTITY is “local” or “alb”, not “${mode}”.`);
  return { mode, identify: PROVIDERS[mode](env) };
}
