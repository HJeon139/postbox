// Attached Claude Code sessions: a session you started in a terminal can join Postbox. It becomes an agent whose
// folder is the session’s folder, and Postbox resumes that same Claude Code session when you write to it. What you
// type in the terminal is mirrored into the thread, marked “from terminal”, by polling the session’s transcript. Lines
// written during Postbox’s own turns are skipped, so nothing shows twice. Moved out of server/runtime.mjs; Runtime
// keeps a method of the same name that delegates here.

import { basename } from 'node:path';
import { describeTool } from './adapters/claude-stream.mjs';
import { contentBlocks, listClaudeSessions, recentHistory, TranscriptTail, typedText } from './adapters/terminal-mirror.mjs';
import { sessionFolder } from './folder-path.mjs';
import { httpError } from './helpers.mjs';
import { runsHere } from './remote/placement.mjs';

export async function claudeSessions(rt) {
  const attached = new Set(
    Object.values(rt.s.sessions)
      .map((se) => se.backendState?.claudeSessionId)
      .filter(Boolean),
  );
  return (await listClaudeSessions({ root: rt.config.claudeProjectsRoot })).map(({ file: _file, ...x }) => ({ ...x, attached: attached.has(x.id) }));
}

export async function attachClaudeSession(rt, { claudeSessionId, projectId, handle }) {
  if (!runsHere(rt, 'claude-code')) throw httpError(422, 'Claude Code isn’t available on this computer, so its sessions can’t be attached.');
  const cs = (await listClaudeSessions({ root: rt.config.claudeProjectsRoot, limit: 500 })).find((x) => x.id === claudeSessionId);
  if (!cs) throw httpError(404, 'That Claude Code session wasn’t found. It may have been deleted.');
  if (!cs.cwd) throw httpError(422, 'That session doesn’t say which folder it ran in, so Postbox can’t resume it.');
  const folder = sessionFolder(cs.cwd);
  if (Object.values(rt.s.sessions).some((se) => se.backendState?.claudeSessionId === claudeSessionId))
    throw httpError(409, 'That session is already attached.');
  if (!rt.s.projects[projectId]) throw httpError(404, 'That project doesn’t exist.');
  const base =
    String(handle || basename(cs.cwd))
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z]+/, '')
      .slice(0, 20) || 'terminal';
  let name = base.length >= 2 ? base : `cc-${base}`;
  for (let n = 2; rt.personaByHandle(name); n++) name = `${base.slice(0, 20)}-${n}`;
  const p = rt.createPersona({
    handle: name,
    backend: 'claude-code',
    description: `Attached from Claude Code in ${cs.cwd}`,
    folder,
  });
  const t = rt.createThread({ projectId, title: cs.title, personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  rt.updateSession(se.id, { backendState: { claudeSessionId, transcript: cs.file, attached: true } });
  for (const it of recentHistory(cs.file)) {
    if (it.kind === 'user') rt.addItem(t.id, { kind: 'user', text: it.text, via: 'terminal' });
    else
      rt.addItem(t.id, {
        kind: 'agent',
        sessionId: se.id,
        personaId: p.id,
        handle: p.handle,
        text: it.text,
        status: 'done',
        via: 'terminal',
        activity: it.steps.length ? { steps: it.steps.map((s) => ({ ...s, state: s.state === 'running' ? 'done' : s.state })) } : null,
      });
  }
  rt.addItem(t.id, { kind: 'system', variant: 'attached', handle: p.handle, folder: cs.cwd });
  rt.mirror(se.id);
  return { threadId: t.id, personaId: p.id, sessionId: se.id };
}

/** Starts following an attached session’s transcript. */
export function mirror(rt, sessionId) {
  const se = rt.s.sessions[sessionId];
  const file = se?.backendState?.transcript;
  if (!file || rt.mirrors.has(sessionId)) return;
  const timer = setInterval(() => rt.pollMirror(sessionId), 1500);
  timer.unref?.();
  rt.mirrors.set(sessionId, { tail: new TranscriptTail(file), timer, agentItem: null, steps: [] });
}

export function rearmMirrors(rt) {
  for (const se of Object.values(rt.s.sessions)) if (se.backendState?.attached && !se.retiredFork) rt.mirror(se.id);
}

export function stopMirrors(rt) {
  for (const m of rt.mirrors.values()) clearInterval(m.timer);
  rt.mirrors.clear();
}

export function pollMirror(rt, sessionId) {
  const m = rt.mirrors.get(sessionId);
  const se = rt.s.sessions[sessionId];
  if (!m) return;
  if (!se) {
    clearInterval(m.timer);
    rt.mirrors.delete(sessionId);
    return;
  }
  // While the store is closed the tail isn’t advanced: what was typed waits in the file and is read after Retry,
  // instead of into memory only, where the reload would discard it (the integrator’s finding on 1b).
  if (!rt.store.writable) return;
  let entries;
  try {
    entries = m.tail.poll();
  } catch {
    return; // the file is being rewritten; try again next time
  }
  // Lines written during Postbox’s own turn are that turn, already in the thread.
  if (rt.turns.has(sessionId) || !entries.length) return;
  for (const e of entries) {
    if (e.isSidechain) continue;
    const typed = typedText(e);
    if (typed) {
      rt.addItem(se.threadId, { kind: 'user', text: typed, via: 'terminal' });
      m.agentItem = null;
      m.steps = [];
      rt.updateSession(sessionId, { state: 'think', currentStep: 'Working in a terminal', finishedAt: null });
      continue;
    }
    if (e.type === 'assistant') {
      for (const b of contentBlocks(e.message?.content)) {
        if (b.type === 'text' && b.text?.trim()) {
          const it = m.agentItem && rt.store.pending.item(se.threadId, m.agentItem);
          if (it) rt.patchItem(se.threadId, it.id, { text: it.text ? `${it.text}\n\n${b.text}` : b.text });
          else m.agentItem = mirrorAgentItem(rt, se, b.text);
          rt.updateSession(sessionId, { state: 'gen', currentStep: 'Writing in a terminal' });
        }
        if (b.type === 'tool_use') {
          m.steps.push({ id: b.id, label: describeTool(b.name, b.input), state: 'running', ms: null });
          if (!m.agentItem) m.agentItem = mirrorAgentItem(rt, se, '');
          rt.patchItem(se.threadId, m.agentItem, { activity: { steps: [...m.steps] } });
          rt.updateSession(sessionId, { state: 'tool', currentStep: m.steps.at(-1).label });
        }
      }
      if (e.message?.stop_reason === 'end_turn') rt.updateSession(sessionId, { state: 'idle', currentStep: '', finishedAt: Date.now() });
    }
    if (e.type === 'user' && Array.isArray(e.message?.content) && m.agentItem) {
      let changed = false;
      for (const b of e.message.content) {
        const step = b.type === 'tool_result' && m.steps.find((s) => s.id === b.tool_use_id);
        if (step) {
          step.state = b.is_error ? 'failed' : 'done';
          changed = true;
        }
      }
      if (changed) rt.patchItem(se.threadId, m.agentItem, { activity: { steps: [...m.steps] } });
    }
  }
}

function mirrorAgentItem(rt, se, text) {
  return rt.addItem(se.threadId, {
    kind: 'agent',
    sessionId: se.id,
    personaId: se.personaId,
    handle: se.handle,
    text,
    status: 'done',
    via: 'terminal',
    activity: null,
  }).id;
}

export function stopMirrorFor(rt, sessionId) {
  const m = rt.mirrors.get(sessionId);
  if (m) clearInterval(m.timer);
  rt.mirrors.delete(sessionId);
}
