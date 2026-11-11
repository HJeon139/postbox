// Postbox’s tools for a remote turn (#120, server/remote/turns.mjs, the header): the daemon’s `tool` is applied as the
// laptop’s MCP server applies a call (server/mcp.mjs), through the same tools, from toolsFor and reactTool, and
// answered with `reply`. Each call is an identity, (turn, id), which the daemon sends again after every hello until
// Postbox has answered it: the reply is kept on the session, so a repeat gets the same answer and is never applied
// twice.

import { LIMITS } from '../../shared/limits.mjs';
import { REMOTE_LIMITS, toolRoute } from '../../shared/remote-protocol.mjs';
import { AgentFileError } from '../agent-files.mjs';
import { assetTools } from '../asset-tools.mjs';
import { noteAnswer } from '../empty-reply.mjs';
import { reactTool } from '../reactions.mjs';
import { blockFiles, keptIfShown } from '../review-files.mjs';
import { recordedTools } from '../scheduled-wakes.mjs';
import { withUrgent } from '../subagent-end.mjs';
import { closedTo, READ_TOOLS } from '../tool-gate.mjs';
import { linkOf } from './turns-need.mjs';
import { KEPT_REPLIES, KEPT_REPLY_CHARS, key, STOPPED_TEXT, send, sessionOfTurn, updateRemote } from './turns-shared.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */
/** @typedef {import('./turns-shared.mjs').Live} Live */

/**
 * A tool that only reads (tool-gate.mjs) changes nothing and its answer can be long, so a host’s repeat runs it again
 * rather than its reply being kept: a kept reply is cut to KEPT_REPLY_CHARS, and an asset’s content mustn’t be kept.
 */
const REPEATABLE = READ_TOOLS;
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
  // Refused by the write gate: nothing ran, and nothing is kept or told, which would be a write the closed store holds
  // only in memory. An outage stops every turn as the store closes (server/store-outage.mjs), so its calls are refused
  // as stopped above; the gate is for a turn still running while the store is closed, which no path makes today. An
  // asked call's agent waits for this reply, so it hears the refusal. A queued call's agent already heard “sent”, once the
  // daemon took it, and the daemon only logs Postbox’s refusal, so it gets no reply: unanswered, it is sent again at the next hello.
  // Queued, its agent heard “sent” from the shim once the daemon took it; a review’s files make it an ask instead
  // (toolRoute, #780).
  const queued = toolRoute(m.name, m.args) === 'queue';
  if (r.closed) return queued ? undefined : void send(link, 'reply', { turn: m.turn, id: m.id, ok: false, text: r.text });
  // An urgent note for the agent comes first, as on the laptop (server/mcp.mjs, #229), in an answer it waits for: a
  // queued call’s reply never reaches it (the shim answered once the daemon took it), so its note waits for the next.
  const text = (queued ? r.text : withUrgent(rts.rt, live.sessionId, r.text, live.rt)).slice(0, REMOTE_LIMITS.replyChars);
  // The reply is kept for the daemon’s repeats, which come after a hello until one is heard: a link that drops
  // before it lands mustn’t post a hand-off, or schedule a wake, twice (#439).
  const now = rts.rt.s.sessions[live.sessionId];
  if (now?.remoteTurn && !REPEATABLE.has(m.name)) {
    const replies = [...(now.remoteTurn.replies ?? []), { turn: m.turn, id: m.id, ok: r.ok, text: text.slice(0, KEPT_REPLY_CHARS) }].slice(-KEPT_REPLIES);
    updateRemote(rts, now.id, { replies });
  }
  // A queued call’s agent already has its answer (the shim’s, once the daemon took it), so Postbox’s refusal goes to
  // it at its next turn instead.
  if (queued && !r.ok) rts.rt.tellAgent(live.sessionId, `Your ${m.name} call from the host didn’t go through: ${text.slice(0, 1000)}`);
  send(link, 'reply', { turn: m.turn, id: m.id, ok: r.ok, text: text || (r.ok ? 'Done.' : 'It failed.') });
}

/** @param {RemoteTurns} rts @param {Live} live @param {{ name: string, args: Record<string, any> }} m @returns {Promise<{ ok: boolean, text: string, closed?: boolean }>} */
async function applyTool(rts, live, m) {
  // react and the asset tools are their own modules’, beside the runtime’s tools and recorded as they are, as server/mcp.mjs
  // adds them; the asset tools take text only here, since a path names a file on the host.
  const own = {
    react: (/** @type {any} */ a) => reactTool(rts.rt, rts.rt.session(live.sessionId), a),
    ...assetTools(rts.rt, live.sessionId, live.rt, { onHost: true }),
  };
  const tools = { ...rts.rt.toolsFor(live.sessionId, live.rt), ...recordedTools(rts.rt, live.rt, own) };
  if (!Object.hasOwn(tools, m.name)) return { ok: false, text: `There’s no tool called “${m.name}”.` };
  // The one write gate, as for a local turn's call (server/tool-gate.mjs): while the store is closed, a write is refused.
  const closed = closedTo(rts.rt, m.name);
  if (closed) return { ok: false, text: closed, closed: true };
  try {
    // show_app’s and update_app’s files, and a review block’s (#780), were read on the host (the broker), and come as base64.
    const app =
      m.name === 'show_app' || m.name === 'update_app' ? await appFiles(rts, m.args) : await blockFiles(rts.rt, live.sessionId, m.name, m.args, hostFile);
    const r = await keptIfShown(app, (given) => tools[m.name](app.args, given));
    noteAnswer(live.rt, m.name, r);
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
    const { sha256, size } = await rts.rt.blobs.put(buf);
    stored.push({ name, sha256, size });
  }
  return { args: rest, files: stored };
}

/**
 * A review block’s file as the host’s broker sent it, { name, path, base64 } (#780): its bytes, for storeReviewFiles
 * to check as it checks a local agent’s. The string is bounded before it’s decoded: no longer than max bytes take
 * in base64, a multiple of 4 and only the alphabet, so a host can’t make Postbox decode more than one image.
 * @param {any} f @param {number} max @param {string} what  “the image “a.png” (up to 5 MiB)”
 */
async function hostFile(f, max, what) {
  const What = what.charAt(0).toUpperCase() + what.slice(1);
  const over = new AgentFileError(`${What} is over its limit as it came from the host, so Postbox didn’t read it.`);
  const s = f?.base64;
  if (typeof s === 'string' && s.length > 4 * Math.ceil(max / 3)) throw over;
  if (typeof s !== 'string' || s.length % 4 || !BASE64.test(s))
    throw new AgentFileError(`${What} didn’t arrive whole from the host, so Postbox didn’t read it.`);
  const buf = Buffer.from(s, 'base64');
  if (buf.length > max) throw over;
  return buf;
}
