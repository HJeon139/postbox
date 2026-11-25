// The fixture person (#558): who “the computer’s account” is wherever Postbox is started to be looked at or recorded,
// in the browser specs, the demo, the screenshot tools and the README’s recording. The repository is public, so
// nothing committed carries the name or login of whoever ran the tool.

/** The fixture person’s git identity, for a repository a tool makes: commits, and what an agent’s harness reads of “the user”. */
export const FIXTURE_GIT = { name: 'Robin Example', email: 'robin@example.com' };

/** @type {import('../server/identity/index.mjs').Principal} */
export const FIXTURE_PERSON = { provider: 'unix', issuer: 'unix:fixture', subject: 'robin', username: 'robin', name: 'Robin Example' };
