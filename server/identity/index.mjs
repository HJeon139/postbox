// Who a request is from (#558): one seam, `identify(req)`, behind which a provider answers with a principal. The
// request gate asks it once per request, and everything past it reads the person that principal is (server/people.mjs),
// never a name from the request’s body. A run on this computer and a Postbox hosted for a team differ only in the
// provider: nothing past this seam asks which one it is.
//
//   local  the account Postbox runs as (server/identity/unix.mjs). The only provider today, and the default.
//
// A provider is a function from a request to a Principal, so another (an identity provider’s signed header, for a
// hosted Postbox) is a module and a line in PROVIDERS.

import { unixAccount } from './unix.mjs';

/**
 * Who a provider says is asking. `issuer` and `subject` together are the key, and the only stable one; `username` and
 * `name` are what a person’s record starts from, theirs to change. `sole` says the provider answers with one person
 * for the whole Postbox, whatever it called them before (the local provider): their record is found by the issuer alone.
 * @typedef {{ provider: string, issuer: string, subject: string, username: string, name: string, sole?: boolean }} Principal
 * @typedef {(req: import('node:http').IncomingMessage) => Principal | Promise<Principal>} Identify
 */

/** @type {Record<string, (opts: { account?: Principal }) => Identify>} */
const PROVIDERS = {
  // `account` is who the computer’s account is, read once: a test, a demo or a screenshot run passes a fixture
  // person’s, so nothing committed carries a real name or login.
  local:
    ({ account = unixAccount() }) =>
    () =>
      account,
};

/**
 * @param {{ provider?: string, account?: Principal }} [opts]
 * @returns {{ provider: string, identify: Identify }}
 */
export function createIdentity({ provider = 'local', account } = {}) {
  if (!Object.hasOwn(PROVIDERS, provider))
    throw new Error(`Postbox has no way to tell who is asking called “${provider}”. It has: ${Object.keys(PROVIDERS).join(', ')}.`);
  return { provider, identify: PROVIDERS[provider]({ account }) };
}
