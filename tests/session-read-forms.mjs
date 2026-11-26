// The forms of a published session read the session guards match (#623, tests/session-write-guard.test.mjs and
// tests/session-decided-guard.test.mjs): the read itself, a getter of one, and a local bound from one.

/**
 * A published read of a session: `rt.s.sessions[id]`, a parameter's `s.sessions[id]`, `state.sessions`, `rt.session(id)`,
 * `rt.sessions.get(id)`. Destructured or by a string key, it fails outright (tests/session-read-guard.test.mjs).
 */
export const PUBLISHED_SESSION = /\bs\.sessions\b|\bstate\.sessions\b|\b(?:rt|this)\.session\(|\bsessions\.get\(/;
/** A getter of a published session, as a turn's handlers read theirs: `const se = () => rt.s.sessions[turn.sessionId]`. */
export const GETTER = /\b(?:const|let)\s+(\w+)\s*=\s*\(\)\s*=>([^;\n]*)/g;
/** A local bound in a function, with what it's bound from. */
export const BIND = /\b(?:const|let|var)\s+(\w+)\s*=([^;]*)/g;
