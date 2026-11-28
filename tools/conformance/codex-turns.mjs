// Codex, resume and fork (#585): does the guide Postbox gives thread/resume and thread/fork reach the model? A turn
// after each of a start, a resume and a fork, in a process of its own as Postbox runs them, against a fake Responses
// endpoint on 127.0.0.1 that records what Codex sends. Each step’s guide carries a marker of its own, so a guide that
// is only still in the thread’s history from the start can’t pass for one the resume or the fork delivered.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openAppServer } from './app-server.mjs';
import { codexConfigToml } from './codex-config.mjs';
import { openThread } from './codex-open.mjs';
import { requestMarkers, startFake } from './fake-responses.mjs';
import { markedGuide, newMarker, withProbeHome } from './probe-home.mjs';
import { recordTo, scrubRequest } from './record.mjs';
import { sandboxEnv } from './sandbox-env.mjs';

/** The message each probe turn sends. */
const TURN_TEXT = 'Reply with ok.';

/**
 * Opens a thread in a new app-server (`open` sends thread/start, resume or fork), runs one turn on it, and returns
 * the thread, the turn, and the requests the fake saw during it.
 * @param {{ bin: string, home: string, env: Record<string, string>, seen: any[] }} probe
 * @param {(request: (method: string, params?: any) => Promise<any>) => Promise<any>} open
 */
async function turnAfter({ bin, home, env, seen }, open) {
  const server = await openAppServer({ bin, cwd: home, env });
  const before = seen.length;
  try {
    const threadId = (await open(server.request)).thread.id;
    const started = await server.request('turn/start', { threadId, input: [{ type: 'text', text: TURN_TEXT }] });
    const done = await server.notified('turn/completed');
    return { threadId, turnId: started.turn.id, status: done.params?.turn?.status, requests: seen.slice(before) };
  } finally {
    await server.stop();
  }
}

/**
 * The result of one step: it passes when the turn completed, Codex sent the model at least one request, and every
 * request held the step’s marker exactly once in all of it, in a developer message that holds the step’s whole guide.
 * `carried`: the start’s marker, reported, not asserted.
 * @param {string} name @param {{ status?: string, requests: any[] }} turn
 * @param {{ marker: string, guide: string }} step @param {string} [carried]
 */
export function stepResult(name, turn, { marker, guide }, carried) {
  const posts = turn.requests.filter((r) => r.path.endsWith('/responses'));
  const counts = posts.map((r) => requestMarkers(r.body, marker, guide));
  const kept = carried ? posts.map((r) => requestMarkers(r.body, carried).developer) : [];
  // Once in all of the request, as a developer message holding the whole guide: never again in another field.
  const delivered = counts.filter((c) => c.developer === 1 && c.whole === 1 && c.anywhere === 1).length;
  const ok = turn.status === 'completed' && posts.length > 0 && delivered === posts.length;
  const history = carried ? `; the start’s guide still in ${kept.filter((n) => n >= 1).length} of them` : '';
  return {
    name,
    ok,
    detail: `turn ${turn.status ?? 'didn’t end'}, ${posts.length} request(s), this step’s whole guide once in ${delivered}${history}`,
  };
}

/**
 * Whether every request the fake was sent carried only the placeholder, and it was sent at least one.
 * @param {{ authOk: boolean }[]} seen
 */
export function authResult(seen) {
  return {
    name: 'the fake was sent only the placeholder',
    ok: seen.length > 0 && seen.every((r) => r.authOk),
    detail: `${seen.filter((r) => !r.authOk).length} of ${seen.length} request(s) had another Authorization`,
  };
}

/**
 * `record`: a folder to write the first request after start into, as guide-request.json, through record.mjs’s
 * allowlist.
 * @param {{ bin: string, record?: string }} opts
 */
export function codexTurnsCheck({ bin, record }) {
  return withProbeHome(async ({ home, codexHome }) => {
    const fake = await startFake();
    try {
      await writeFile(join(codexHome, 'config.toml'), codexConfigToml(fake.baseUrl));
      const probe = { bin, home, env: sandboxEnv({ home, codexHome, placeholder: true }), seen: fake.seen };
      const step = (/** @type {string} */ what) => {
        const marker = newMarker(what);
        return { marker, guide: markedGuide('codex', marker) };
      };
      const steps = { start: step('start'), resume: step('resume'), fork: step('fork') };
      const start = await turnAfter(probe, (rq) => openThread(rq, { cwd: home, guide: steps.start.guide }));
      const { threadId } = start;
      const resume = await turnAfter(probe, (rq) => openThread(rq, { cwd: home, guide: steps.resume.guide, sourceThreadId: threadId }));
      const fork = await turnAfter(probe, (rq) => openThread(rq, { cwd: home, guide: steps.fork.guide, sourceThreadId: threadId, forkTurnId: resume.turnId }));
      const first = start.requests.find((r) => r.path.endsWith('/responses'));
      if (record && first) {
        const keep = (/** @type {string} */ text) => text === steps.start.guide || text === TURN_TEXT; // exactly the probe’s own texts
        await recordTo(record, 'guide-request.json', `${JSON.stringify(scrubRequest(first.body, keep), null, 2)}\n`);
      }
      return [
        stepResult('a turn after start sends its guide', start, steps.start),
        stepResult('a turn after resume sends the resume’s guide', resume, steps.resume, steps.start.marker),
        stepResult('a turn after fork sends the fork’s guide', fork, steps.fork, steps.start.marker),
        authResult(fake.seen),
      ];
    } finally {
      await fake.close();
    }
  });
}
