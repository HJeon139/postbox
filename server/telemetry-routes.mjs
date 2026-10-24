// The telemetry routes (designs/telemetry-persona.md, R1, R11, R18, R19), which server/index.mjs’s route() calls in one
// line: recording a conversation from its ⋯ menu, and the Telemetry view’s report, its Leave out, Save, File issue and
// Delete. Every write here needs the page’s token, as every other one does (tests/server-token.test.mjs reads this file).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { httpError } from './helpers.mjs';
import { convOf, deleteRecordings, startRecording, stopRecording, telemetryRoot } from './telemetry.mjs';
import { fileIssue, issuePreview } from './telemetry-file.mjs';
import { draftView, makeReport } from './telemetry-report.mjs';
import { deleteReport, discardDraft, savedReports, saveReport, setLeftOut } from './telemetry-save.mjs';

const done = (status, body) => ({ status, body });
const decoded = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    throw httpError(400, 'That finding’s key doesn’t decode.');
  }
};

/** What the Telemetry view opens on: the recording’s state, the newest report not yet saved, and the saved ones. */
function overview(rt, threadId) {
  const conv = convOf(rt, threadId);
  const root = telemetryRoot(rt);
  const dir = conv && root ? join(root, conv.id, 'recording', 'drafts') : null;
  const open = (dir && existsSync(dir) ? readdirSync(dir) : [])
    .map((f) => JSON.parse(readFileSync(join(dir ?? '', f), 'utf8')))
    .filter((d) => !d.saved)
    .sort((a, b) => b.at - a.at)[0];
  return { recording: conv?.recording ?? null, draft: open?.report?.id ?? null, saved: savedReports(rt, threadId) };
}

/**
 * Answers a telemetry route, or null when the path isn’t one.
 * @param {any} rt @param {string} path @param {string} method @param {any} body
 * @returns {Promise<{ status: number, body: any } | null>}
 */
export async function telemetryRoute(rt, path, method, body) {
  const thread = /^\/api\/threads\/([^/]+)\/telemetry(\/|$)/.exec(path)?.[1];
  if (!thread) return null;
  // An unknown conversation or a key that doesn’t decode is the request’s mistake, not the server’s.
  if (!rt.s.threads[thread]) throw httpError(404, 'That conversation doesn’t exist.');
  const b = body ?? {};
  let m;
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/telemetry$/)) && method === 'GET') return done(200, overview(rt, m[1]));
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/telemetry\/record$/)) && method === 'POST') return done(200, startRecording(rt, m[1]));
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/telemetry\/stop$/)) && method === 'POST') return done(200, stopRecording(rt, m[1]));
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/telemetry\/delete$/)) && method === 'POST') return done(200, deleteRecordings(rt, m[1]));
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/telemetry\/reports$/)) && method === 'POST')
    return done(201, await makeReport(rt, m[1], { history: b.history === true }));
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/telemetry\/reports\/([^/]+)$/)) && method === 'GET')
    return done(200, draftView(rt, convOf(rt, m[1]).id, m[2]));
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/telemetry\/reports\/([^/]+)$/)) && method === 'DELETE') return done(200, deleteReport(rt, m[1], m[2]));
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/telemetry\/reports\/([^/]+)\/leave-out$/)) && method === 'POST')
    return done(200, setLeftOut(rt, m[1], m[2], b));
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/telemetry\/reports\/([^/]+)\/save$/)) && method === 'POST') return done(200, saveReport(rt, m[1], m[2], b));
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/telemetry\/reports\/([^/]+)\/discard$/)) && method === 'POST') return done(200, discardDraft(rt, m[1], m[2]));
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/telemetry\/reports\/([^/]+)\/issues\/([^/]+)$/)) && method === 'GET')
    return done(200, issuePreview(rt, convOf(rt, m[1])?.id, m[2], decoded(m[3])));
  if ((m = path.match(/^\/api\/threads\/([^/]+)\/telemetry\/reports\/([^/]+)\/issues\/([^/]+)$/)) && method === 'POST')
    return done(200, await fileIssue(rt, convOf(rt, m[1])?.id, m[2], decoded(m[3]), b));
  return null;
}
