// Who a request is from (#558): one seam, `identify(req)`, behind which a provider answers with a principal. The
// request gate asks it once per request, and everything past it reads the person that principal is (server/people.mjs),
// never a name from the request’s body. A run on this computer and a Postbox hosted for a team differ only in the
// provider: nothing past this seam asks which one it is.
//
//   local  the account Postbox runs as (server/identity/unix.mjs). The default.
//   alb    whoever an AWS Application Load Balancer signed in, for a hosted Postbox (server/identity/alb.mjs,
//          designs/architecture/hosted.md). Chosen by giving sign-in settings, which name it.
//
// A provider is a function from a request to a Principal, so another is a module and a line in PROVIDERS.

import { albProvider } from './alb.mjs';
import { signInSettings } from './sign-in-settings.mjs';
import { unixAccount } from './unix.mjs';

/**
 * Who a provider says is asking. `issuer` and `subject` together are the key, and the only stable one; `username` and
 * `name` are what a person’s record starts from, theirs to change. `sole` says the provider answers with one person
 * for the whole Postbox, whatever it called them before (the local provider): their record is found by the issuer alone.
 * @typedef {{ provider: string, issuer: string, subject: string, username: string, name: string, sole?: boolean }} Principal
 * @typedef {(req: import('node:http').IncomingMessage) => Principal | Promise<Principal>} Identify
 */

/**
 * A hosted Postbox’s sign-in: the deployment’s settings (server/identity/sign-in-settings.mjs), and how a key’s text is
 * fetched, which a test stands in for.
 * @typedef {{ settings: unknown, get: (url: string) => Promise<string>, now?: () => number }} SignIn
 */

/** @type {Record<string, (opts: { account?: Principal, signIn?: SignIn }) => Identify>} */
const PROVIDERS = {
  // `account` is who the computer’s account is, read once: a test, a demo or a screenshot run passes a fixture
  // person’s, so nothing committed carries a real name or login.
  local:
    ({ account = unixAccount() }) =>
    () =>
      account,
  // Refused as Postbox starts when the settings leave anything out, an allow list above all (#1733).
  alb: ({ signIn }) => {
    if (!signIn) throw new Error('The “alb” provider needs the deployment’s sign-in settings.');
    return albProvider(signInSettings(signIn.settings), { get: signIn.get, now: signIn.now });
  },
};

/**
 * @param {{ provider?: string, account?: Principal, signIn?: SignIn }} [opts]
 *   signIn: given, the provider is the one its settings name, and no account of this computer is anyone
 * @returns {{ provider: string, identify: Identify }}
 */
export function createIdentity({ signIn, provider = signIn ? 'alb' : 'local', account } = {}) {
  if (!Object.hasOwn(PROVIDERS, provider))
    throw new Error(`Postbox has no way to tell who is asking called “${provider}”. It has: ${Object.keys(PROVIDERS).join(', ')}.`);
  return { provider, identify: PROVIDERS[provider]({ account, signIn }) };
}
