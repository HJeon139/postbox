// A hosted Postbox’s sign-in settings (designs/architecture/hosted.md, “Who is asking”; #1733): what the deployment
// says of its own load balancer and identity provider, and who may sign in. They are checked whole as Postbox starts,
// and refused in words that say what is missing: a hosted Postbox doesn’t start without an allow list. Nothing here
// says who anyone is; it says how to tell.

/** An AWS region’s name, as server/identity/alb-keys.mjs takes one. */
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const FIELDS = ['provider', 'region', 'signer', 'client', 'issuer', 'claims', 'allow'];

/** A non-empty list of non-empty strings, or nothing. @param {unknown} list */
const names = (list) => (Array.isArray(list) && list.length && list.every((x) => typeof x === 'string' && x) ? /** @type {string[]} */ ([...list]) : null);

/**
 * Who may sign in: people by their subject, or anyone in one of some groups, read from a claim the deployment names.
 * @param {any} allow @returns {{ subjects: string[], groups: { claim: string, any: string[] } | null } | null}
 */
function allowList(allow) {
  const subjects = names(allow?.subjects);
  const any = names(allow?.groups?.any);
  const groups = any && typeof allow.groups.claim === 'string' && allow.groups.claim ? { claim: allow.groups.claim, any } : null;
  return subjects || groups ? { subjects: subjects ?? [], groups } : null;
}

/**
 * The settings as the provider reads them, or a refusal that says what to set.
 * @param {unknown} given  as the deployment’s settings file holds them
 * @returns {{ provider: 'alb', region: string, signer: string, client: string, issuer: string,
 *             claims: { username: string, name: string }, allow: NonNullable<ReturnType<typeof allowList>> }}
 */
export function signInSettings(given) {
  if (given === null || typeof given !== 'object' || Array.isArray(given))
    throw new Error('A hosted Postbox’s sign-in settings are an object: its provider, region, signer, client, issuer, claims and allow list.');
  const s = /** @type {Record<string, any>} */ (given);
  for (const key of Object.keys(s)) if (!FIELDS.includes(key)) throw new Error(`Sign-in settings have no “${key}”. They have: ${FIELDS.join(', ')}.`);
  const missing = (/** @type {string} */ field, /** @type {string} */ what) => new Error(`Sign-in settings need “${field}”: ${what}.`);
  if (s.provider !== 'alb') throw missing('provider', 'the one Postbox has is “alb”, an AWS Application Load Balancer');
  if (typeof s.region !== 'string' || !REGION.test(s.region)) throw missing('region', 'the load balancer’s AWS region, such as us-west-2');
  for (const [field, what] of [
    ['signer', 'the load balancer’s ARN'],
    ['client', 'the client id the load balancer signs people in with'],
    ['issuer', 'the identity provider’s issuer URL'],
  ])
    if (typeof s[field] !== 'string' || !s[field]) throw missing(field, what);
  for (const claim of ['username', 'name'])
    if (typeof s.claims?.[claim] !== 'string' || !s.claims[claim])
      throw missing(`claims.${claim}`, `the claim that holds a person’s ${claim === 'username' ? 'user name' : 'name'}`);
  const allow = allowList(s.allow);
  if (!allow)
    throw new Error(
      'A hosted Postbox needs an allow list, and its sign-in settings have none. Set “allow” to who may sign in: “subjects”, a list of people by their subject, or “groups”, a claim and the groups in it.',
    );
  return {
    provider: 'alb',
    region: s.region,
    signer: s.signer,
    client: s.client,
    issuer: s.issuer,
    claims: { username: s.claims.username, name: s.claims.name },
    allow,
  };
}
