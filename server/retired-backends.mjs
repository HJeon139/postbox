// The Agent SDK backend is gone (#1831): it ran the same Claude Code, with the same sign-in, models and tools, inside
// Postbox’s own process, and couldn’t run on a host. A store an older Postbox wrote can still name it, so what it
// holds moves to Claude Code as the store loads, with nothing for the person to answer. The agent keeps its settings,
// its folder, its memory and its place in each conversation, and its next turn resumes the same session: the SDK ran
// Claude Code’s CLI, which keeps a session by its id whichever of the two started it. If the CLI no longer has it, the
// turn starts a new session and tells the agent so, as for any session Claude Code lost (server/adapters/claude-code.mjs).

/** The backend’s name in a store an older Postbox wrote. */
const AGENT_SDK = 'agent-sdk';
const CLAUDE_CODE = 'claude-code';

/**
 * A fork point or a session’s state with the SDK’s session id under Claude Code’s name. Claude Code’s own id stays when
 * the agent last ran on Claude Code (`latest` false): the SDK’s is then an older session’s.
 * @param {any} state @param {boolean} latest  whether the SDK’s id is the session the agent last ran in
 */
function underClaudeCode(state, latest) {
  if (!state || typeof state !== 'object' || !('sdkSessionId' in state)) return state;
  const { sdkSessionId, ...rest } = state;
  return sdkSessionId && (latest || !rest.claudeSessionId) ? { ...rest, claudeSessionId: sdkSessionId } : rest;
}

/** A session’s backend state without the SDK’s names. @param {any} state @param {boolean} latest */
function stateOnClaudeCode(state, latest) {
  const next = underClaudeCode(state, latest);
  const fork = underClaudeCode(next.fork, latest);
  const forkFrom = underClaudeCode(next.forkFrom, latest);
  return fork === next.fork && forkFrom === next.forkFrom ? next : { ...next, ...(next.fork ? { fork } : {}), ...(next.forkFrom ? { forkFrom } : {}) };
}

/**
 * Every stored persona, saved agent (boilerplate) and session on the Agent SDK runs on Claude Code, and the SDK’s own
 * quota record goes: Claude Code reports the same account’s. Written once, as the store loads; a store with none
 * writes nothing.
 * @param {any} rt
 */
export function retireBackends(rt) {
  const moved = new Set();
  for (const p of Object.values(rt.s.personas)) {
    if (p.backend !== AGENT_SDK) continue;
    moved.add(p.id);
    rt.store.emit('persona', { ...p, backend: CLAUDE_CODE });
  }
  for (const b of Object.values(rt.s.boilerplates ?? {})) if (b.backend === AGENT_SDK) rt.store.emit('boilerplate', { ...b, backend: CLAUDE_CODE });
  for (const se of Object.values(rt.s.sessions)) {
    const backendState = se.backendState ? stateOnClaudeCode(se.backendState, moved.has(se.personaId)) : se.backendState;
    const patch = { ...(se.backend === AGENT_SDK ? { backend: CLAUDE_CODE } : {}), ...(backendState !== se.backendState ? { backendState } : {}) };
    if (Object.keys(patch).length) rt.store.emit('session.patch', { id: se.id, patch });
  }
  for (const q of Object.values(rt.s.quota ?? {})) if (q.backend === AGENT_SDK) rt.store.emit('remove', { kind: 'quota', id: q.id });
}
