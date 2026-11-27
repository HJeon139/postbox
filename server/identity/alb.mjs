// The sign-in provider of a hosted Postbox (designs/architecture/hosted.md, “Who is asking”): who a request is from,
// read from the token an AWS Application Load Balancer forwards in `x-amzn-oidc-data`. The token is checked whole
// (server/identity/alb-token.mjs) on every request, since the port is reachable by whatever the network lets reach it,
// and the person must be on the deployment’s allow list (#1733). The unsigned headers the load balancer also adds
// (`x-amzn-oidc-identity`, `x-amzn-oidc-accesstoken`) prove nothing and are never read, logged, kept or sent on.

import { PROFILE } from '../../shared/limits.mjs';
import { httpError } from '../helpers.mjs';
import { albKeys } from './alb-keys.mjs';
import { checkAlbToken } from './alb-token.mjs';

/** A refusal that says only “sign in”: why is kept on it as `reason`, for the log the deployment slice adds, and never sent. */
const signIn = (/** @type {unknown} */ reason) => Object.assign(httpError(401, 'Sign in to use this Postbox.'), { code: 'sign-in', reason });

/** A claim’s text on one line, or nothing when it isn’t text. @param {unknown} value */
const line = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** Whether the allow list names this person: by their subject, or by a group their claims put them in. */
function allowed(/** @type {ReturnType<typeof import('./sign-in-settings.mjs').signInSettings>['allow']} */ allow, subject, claims) {
  if (allow.subjects.includes(subject)) return true;
  if (!allow.groups) return false;
  const theirs = claims[allow.groups.claim];
  const groups = Array.isArray(theirs) ? theirs : [theirs];
  return groups.some((g) => typeof g === 'string' && allow.groups?.any.includes(g));
}

/**
 * @param {ReturnType<typeof import('./sign-in-settings.mjs').signInSettings>} settings
 * @param {{ get: (url: string) => Promise<string>, now?: () => number }} io  get: fetches a key’s text from the region’s endpoint
 * @returns {import('./index.mjs').Identify}
 */
export function albProvider(settings, { get, now = Date.now }) {
  const keyOf = albKeys({ region: settings.region, get, now });
  return async (req) => {
    const checked = await checkAlbToken(req.headers['x-amzn-oidc-data'], { ...settings, keyOf, now }).catch((e) => {
      // A check that couldn’t be made at all is the server’s fault, not the request’s.
      throw e.status === 401 ? signIn(e.code) : e;
    });
    // Who they are comes from the claims the deployment names, each on one line within a name’s length, and neither
    // is made up when a claim is missing. A user name is taken as the provider gives it: one a mention can’t be
    // written with (an email address, a name with a dot) is the provider’s to solve, and that person is reached by
    // @you (the owner’s ruling on #1742).
    const [username, name] = [settings.claims.username, settings.claims.name].map((claim) => line(checked.claims[claim]).slice(0, PROFILE.name));
    // Signed by the deployment’s own load balancer, so they are signed in, and signing in again wouldn’t help.
    if (!username || !name)
      throw Object.assign(
        httpError(
          403,
          'You’re signed in, but your sign-in doesn’t give the name and user name this Postbox reads. Ask whoever runs it to check its sign-in settings.',
        ),
        { code: 'claims' },
      );
    // An email address a person typed and nobody checked is anyone’s to claim, so one that names them here must be
    // one the provider verified (the claim is `true`, or the text “true” as Amazon Cognito sends it).
    if (Object.values(settings.claims).includes('email') && String(checked.claims.email_verified) !== 'true')
      throw Object.assign(
        httpError(403, 'You’re signed in, but your email address isn’t verified with the sign-in provider. Verify it there, then sign in again.'),
        { code: 'unverified' },
      );
    if (!allowed(settings.allow, checked.subject, checked.claims))
      throw Object.assign(httpError(403, `You’re signed in as ${name}, and this Postbox isn’t open to you. Ask whoever runs it to add you.`), {
        code: 'not-allowed',
      });
    return { provider: 'alb', issuer: checked.issuer, subject: checked.subject, username, name, until: checked.until };
  };
}
