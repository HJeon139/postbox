// Postbox’s tools for a remote turn (#120, server/remote/turns.mjs, the header): the daemon’s `tool` is applied as the
// laptop’s MCP server applies a call (server/mcp.mjs), through the same tools, from toolsFor and reactTool, and
// answered with `reply`. Each call is an identity, (turn, id), which the daemon sends again after every hello until
// Postbox has answered it: a queued tool’s reply is kept on the session, so a repeat gets the same answer and is never
// applied twice.

import { LIMITS } from '../../shared/limits.mjs';
import { REMOTE_LIMITS } from '../../shared/remote-protocol.mjs';
import { reactTool } from '../reactions.mjs';
import { linkOf } from './turns-need.mjs';
import { KEPT_REPLIES, KEPT_REPLY_CHARS, key, STOPPED_TEXT, send, sessionOfTurn, TOOL_QUEUED, updateRemote } from './turns-shared.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */
/** @typedef {import('./turns-shared.mjs').Live} Live */

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A shim tool call: applied through the same tools the laptop’s MCP server uses, and answered with `reply`.
 * @param {RemoteTurns} rts @param {string} hostId @param {{ turn: string, id: string, name: string, args: Record<string, any> }} m
 */
export async function onTool(rts, hostId, m) {
  const k = key(m.turn, m.id);
  const link = linkOf(rts, hostId);
  const se = sessionOfTurn(rts, m.turn);
  const done = se?.remoteTurn?.replies?.find((/** @type {any} */ r) => r.turn === m.turn && r.id === m.id);
  if (done) return void send(link, 'reply', { turn: m.turn, id: m.id, ok: done.ok, text: done.text });
  if (rts.applying.has(k)) return;
  const live = rts.byTurn.get(m.turn);
  // A call from a turn that was stopped or has ended is refused, as on the laptop (#126).
  if (!live || live.rt.closed) return void send(link, 'reply', { turn: m.turn, id: m.id, ok: false, text: STOPPED_TEXT });
  rts.applying.add(k);
  let r;
  try {
    r = await applyTool(rts, live, m);
  } finally {
    rts.applying.delete(k);
  }
  const text = r.text.slice(0, REMOTE_LIMITS.replyChars);
  // A queued call’s agent already has its answer (the shim’s), so its reply is kept for the daemon’s repeats, and
  // a failure goes to the agent at its next turn instead.
  if (TOOL_QUEUED.has(m.name)) {
    const now = rts.rt.s.sessions[live.sessionId];
    if (now?.remoteTurn) {
      const replies = [...(now.remoteTurn.replies ?? []), { turn: m.turn, id: m.id, ok: r.ok, text: text.slice(0, KEPT_REPLY_CHARS) }].slice(-KEPT_REPLIES);
      updateRemote(rts, now.id, { replies });
    }
    if (!r.ok) rts.rt.tellAgent(live.sessionId, `Your ${m.name} call from the host didn’t go through: ${text.slice(0, 1000)}`);
  }
  send(link, 'reply', { turn: m.turn, id: m.id, ok: r.ok, text: text || (r.ok ? 'Done.' : 'It failed.') });
}

/** @param {RemoteTurns} rts @param {Live} live @param {{ name: string, args: Record<string, any> }} m @returns {Promise<{ ok: boolean, text: string }>} */
async function applyTool(rts, live, m) {
  // react is the reactions’ own (server/reactions.mjs), beside the runtime’s tools, as server/mcp.mjs adds it.
  const tools = { ...rts.rt.toolsFor(live.sessionId, live.rt), react: (/** @type {any} */ a) => reactTool(rts.rt, rts.rt.session(live.sessionId), a) };
  if (m.name === 'add_dataset')
    return {
      ok: false,
      text: 'add_dataset loads a file on Postbox’s computer, which an agent on a remote host can’t name, so it isn’t available there yet.',
    };
  if (!Object.hasOwn(tools, m.name)) return { ok: false, text: `There’s no tool called “${m.name}”.` };
  try {
    // show_app’s and update_app’s files were read on the host (the broker), and come as base64.
    const app = m.name === 'show_app' || m.name === 'update_app' ? await appFiles(rts, m.args) : { args: m.args };
    const r = await tools[m.name](app.args, app.files ? { files: app.files } : {});
    return { ok: !(r.ok === false && !r.waiting), text: r.results ? JSON.stringify(r.results) : String(r.message ?? '') };
  } catch (e) {
    return { ok: false, text: String(e.userMessage ?? e.message) };
  }
}

/**
 * An app’s data files from the host: [{ name, base64 }], stored as the laptop stores the ones it reads (appFiles).
 * @param {RemoteTurns} rts @param {Record<string, any>} args
 */
async function appFiles(rts, args) {
  const { files, ...rest } = args ?? {};
  if (files === undefined) return { args: rest };
  const fail = (/** @type {string} */ text) => Object.assign(new Error(text), { userMessage: text });
  if (!Array.isArray(files)) throw fail('files is a list: [{ name?, path }].');
  if (files.length > LIMITS.appFiles) throw fail(`An app carries up to ${LIMITS.appFiles} data files.`);
  if (!rts.rt.blobs) throw fail('This Postbox can’t store files.');
  /** @type {{ name: string, sha256: string, size: number }[]} */
  const stored = [];
  for (const f of files) {
    const name = String(f?.name ?? '');
    if (!FILE_NAME.test(name)) throw fail(`“${name}” can’t name a file: use letters, digits and - _ . (up to 64).`);
    if (stored.some((x) => x.name === name)) throw fail(`Two files are named “${name}”.`);
    if (typeof f.base64 !== 'string' || f.base64.length % 4 || !BASE64.test(f.base64)) throw fail(`The file “${name}” didn’t arrive whole from the host.`);
    const buf = Buffer.from(f.base64, 'base64');
    if (buf.length > LIMITS.appFileBytes) throw fail(`The file “${name}” is over the limit for an app’s data file.`);
    stored.push({ name, ...(await rts.rt.blobs.put(buf)) });
  }
  return { args: rest, files: stored };
}
