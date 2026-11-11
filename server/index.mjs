// Postbox server: serves the app, the API, live updates over server-sent events, the MCP endpoint and
// the sandbox frames for agent-written apps. Node only, no dependencies.
//
//   node server/index.mjs [--port 4173] [--data <folder>] [--fresh] [--demo]
//
// The same as the postbox command (bin/postbox.mjs), which reads the flags and finds the data folder (server/home.mjs).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterRegistry } from './adapters/adapter.mjs';
import { MockAdapter } from './adapters/mock.mjs';
import { PROBES, registerBackends } from './backends.mjs';
import { INLINE_TYPES } from './blobs.mjs';
import { buildInfo } from './build-info.mjs';
import { dismissFailed } from './card-needs.mjs';
import { Corpus } from './corpus.mjs';
import { openDataFolder } from './data-folder.mjs';
import { listFolder } from './folders.mjs';
import { dataFolder } from './home.mjs';
import { hostsRoute } from './hosts-routes.mjs';
import { listen as listenServer } from './listen.mjs';
import { liveStreams } from './live-streams.mjs';
import { handleMcp } from './mcp.mjs';
import { Narrator, narrationInstalled } from './narration/narrator.mjs';
import { pageState } from './page-state.mjs';
import { rearmPersonaDeletes } from './persona-delete.mjs';
import { createProject, setPushUrl } from './projects.mjs';
import { hostManagerFor, startHosts, stopHosts } from './remote/serve.mjs';
import { settleInterrupted } from './restart-sweep.mjs';
import { SAME_ORIGIN_ONLY, servedReviewFile } from './review-files.mjs';
import { patchThread } from './room-chain-limit.mjs';
import { httpError, Runtime } from './runtime.mjs';
import { sandboxRoute } from './sandbox-routes.mjs';
import { seed, toBoilerplate } from './seed.mjs';
import { decodePath, file, mediaPath, servedFile } from './served-files.mjs';
import { sessionRoute } from './session-routes.mjs';
import { setupRoute } from './setup-routes.mjs';
import { isLoopback } from './shell.mjs';
import { newId } from './store.mjs';
import { watchTelemetry } from './telemetry.mjs';
import { telemetryRoute } from './telemetry-routes.mjs';
import { storedName, uploadName } from './upload-name.mjs';
import { startViewApp } from './view-app/view-app.mjs';
import { viewOf } from './view-app/view-of.mjs';

/** The routes that stop an agent’s turn, a background job or a `!` command: allowed while the store is closed, as Stop must be. */
const STOP_ROUTE = /^\/api\/(sessions\/[^/]+\/(stop|jobs\/[^/]+\/stop)|threads\/[^/]+\/shell\/[^/]+\/stop)$/;

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const STATIC = {
  '/app/': join(ROOT, 'app'),
  '/shared/': join(ROOT, 'shared'),
  '/kit/': join(ROOT, 'app', 'kit'),
  // Only in a clone: an installed package doesn’t ship the mockups.
  '/mockups/': join(ROOT, 'mockups'),
};
// /media/ serves the media that comes with Postbox, then the media agents added to the data folder (#90). It’s the only
// place an app’s sandbox loads images from (server/sandbox.mjs), and the package’s own folder isn’t the person’s to
// write in: an upgrade replaces it.
const BUNDLED_MEDIA = join(ROOT, 'app', 'media');
// The data folder’s media is images only, each sent as a sandboxed page with no script if it’s opened: an agent, or an
// archive it unpacked, could put an HTML page or a scripted SVG there, and on Postbox’s origin it would carry the page’s
// token cookie. It goes without the open CORS header, too, which would let another site’s script read it.
const MEDIA_HEADERS = { 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" };
// A command’s output from the work ledger (#132) is text the page reads, never a page, and it stays on Postbox’s own
// origin (#820).
const OUTPUT_HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...SAME_ORIGIN_ONLY };

/**
 * @param {{ port?: number, dataDir?: string, fresh?: boolean, demo?: boolean, quiet?: boolean, claudeHome?: string, listen?: boolean,
 *           host?: string, spawnShell?: typeof import('node:child_process').spawn, hosts?: import('./remote/hosts.mjs').HostManager|null,
 *           wake?: Parameters<typeof import('./remote/wake.mjs').watchWake>[1], probes?: Partial<typeof PROBES>, archiveTurns?: boolean }} [opts]
 *   claudeHome: where the person’s Claude Code config is read for the persona sheet’s MCP list (the home folder;
 *   checks pass a temp folder, so they never read the real one)
 *   listen: false builds everything but doesn’t listen, so tests can call the returned handle(req, res) directly
 *   host: the address it listens on, 127.0.0.1; `!` commands refuse to run on any other (tests check that)
 *   spawnShell: how `!` commands start (tests pass a fake)
 *   hosts: the remote hosts’ manager (#120). Left out, Postbox makes its own (server/remote/hosts.mjs), keeping the
 *   hosts’ tokens in dataDir; tests pass a fake, or null for none, and then agents run only on this computer
 *   wake: the clock and timers that notice this computer waking, so the hosts reconnect (tests pass fakes)
 *   probes: how the real backends are looked for (PROBES); tests pass fakes, which turn them on even with
 *   POSTBOX_BACKENDS=mock
 */
export async function start({
  port = 4173,
  dataDir = dataFolder({ root: ROOT }).dataDir,
  fresh = false,
  demo = false,
  quiet = false,
  claudeHome = homedir(),
  listen = true,
  host = '127.0.0.1',
  spawnShell = undefined,
  hosts: given = undefined,
  wake = undefined,
  probes = undefined,
  archiveTurns = false,
} = {}) {
  const origin = `http://127.0.0.1:${port}`;
  process.env.POSTBOX_ORIGIN = origin;
  const { store, blobs, mediaDir } = await openDataFolder(dataDir, { fresh });
  const corpus = await new Corpus().loadDir(join(ROOT, 'server', 'corpus', 'books'));
  const adapters = new AdapterRegistry().register(new MockAdapter());
  const { real, claude, kiro, agy, codex } = await registerBackends(adapters, { dataDir, demo, probes });
  const config = {
    origin,
    // Which build this is, shown under Personas in the sidebar.
    build: buildInfo({ root: ROOT }),
    imageOrigins: [origin, 'https://www.gutenberg.org', 'https://upload.wikimedia.org'],
    versions: { claudeCode: claude, kiroCli: kiro, antigravityCli: agy, codex },
    // The person’s Claude Code user settings live here: the permissions panel reads and writes their rules (#66).
    home: claudeHome,
    archiveTurns: archiveTurns === true, // the archive pass (#305), off until step 4: only `true` turns it on
  };
  // Kokoro is optional; without it, narration says it isn’t installed.
  const narrator = narrationInstalled() ? new Narrator({ modelsDir: join(dataDir, 'models'), blobs }) : null;
  // The hosts’ links (#120), made on first use (server/remote/serve.mjs).
  const hosts = hostManagerFor(given, () => rt, dataDir, config.build.version);
  const rt = new Runtime({ store, adapters, corpus, config, blobs, narrator, spawnShell, hosts });
  // view_app’s browser, downloaded only after the person agrees (#95; designs/architecture.md, “Agents see their app”).
  startViewApp(rt, { dataDir, origin: () => `http://127.0.0.1:${/** @type {any} */ (server.address())?.port ?? port}` });
  // Recording conversations for telemetry, and its 30-day sweep (designs/telemetry-persona.md, R7, R11).
  watchTelemetry(rt);
  const firstReal = ['claude-code', 'agent-sdk', 'kiro-cli', 'antigravity-cli', 'codex'].find((b) => adapters.runsHere(b)) ?? 'mock';
  await seed(rt, { dataDir, booksDir: join(ROOT, 'server', 'corpus', 'books'), backend: firstReal, demo });
  settleInterrupted(rt);
  for (const [threadId, list] of Object.entries(store.state.items))
    for (const it of list) if (it.status === 'streaming') rt.patchItem(threadId, it.id, { status: 'stopped' });
  rt.rearmSchedules();
  rt.rearmDeletions();
  rearmPersonaDeletes(rt);
  rt.expireStalePermissions();
  rt.expireStaleCommands();
  rt.ledger.expireStale();
  rt.expireStaleJobs();
  rt.rearmMirrors();
  // Turns that went on on their hosts are attached again, each host’s status is kept for the page, and the hosts
  // reconnect when this computer wakes (#120).
  const stopWake = startHosts(rt, hosts, wake);
  await loadCorpusFiles(store, corpus, blobs);
  // Datasets agents loaded (#47) come back from their projects’ .postbox/datasets/.
  await rt.reloadDatasets();

  // The page’s token (#74): a secret made at each launch, which a browser gets in a cookie when it loads `/`. Every
  // write needs it, so an agent that uses Postbox’s API with curl, casually or because something told it to, can’t
  // post as the person. The cookie is HttpOnly (neither the page’s script nor an app can read it) and SameSite=Strict
  // (another site can’t make the browser send it). A page on another port of this computer is the same site, so the
  // browser does send it there: the Origin check refuses those. Cookies don’t keep ports apart, so its name has the
  // port, and two Postboxes on one computer don’t overwrite each other’s.
  const token = Buffer.from(randomBytes(32).toString('base64url'));
  const cookieName = `pb_token_${port}`;
  const cookieRe = new RegExp(`(?:^|;\\s*)${cookieName}=([^;]*)`); // lint-allow regex: pb_token_ and the port number
  const hasToken = (req) => {
    const sent = Buffer.from(String(req.headers.cookie ?? '').match(cookieRe)?.[1] ?? '');
    return sent.length === token.length && timingSafeEqual(sent, token);
  };
  // Only a browser gets it: a navigation, or the page’s own fetch of `/` (its token refresh after a restart), which
  // browsers mark with Fetch Metadata headers. A plain `curl /` sends none, so it gets the page and no cookie. A
  // process that forges these headers on purpose still can; see designs/architecture.md §13.
  const fromBrowser = (req) =>
    req.headers['sec-fetch-mode'] === 'navigate' || req.headers['sec-fetch-site'] === 'same-origin' || req.headers['sec-fetch-site'] === 'none';

  // `!` runs commands as the person (#67), so it’s off unless Postbox listens on this computer alone and the request
  // came from it, on top of the page’s token. Postbox listens on 127.0.0.1 today; a later change to that can’t open
  // this silently.
  const shellAllowed = (req) => {
    if (!isLoopback(host)) throw httpError(403, `! commands run only while Postbox listens on this computer alone (127.0.0.1), and it’s listening on ${host}.`);
    if (!isLoopback(req.socket?.remoteAddress)) throw httpError(403, '! commands run only from this computer.');
  };

  // The pages’ live updates: the store’s events over server-sent events (server/live-streams.mjs).
  const { streams, stop: stopStreams, stream } = liveStreams(store);
  let offlineUntil = 0;

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  const handle = async (req, res) => {
    try {
      await route(req, res);
    } catch (e) {
      const status = e.status ?? 500;
      if (status === 500) console.error(e);
      if (!res.headersSent)
        send(res, status, {
          error: e.userMessage ?? (status === 500 ? 'Something went wrong on the server. Try again; if it keeps happening, check the server log.' : e.message),
          fieldErrors: e.fieldErrors,
          code: e.code,
          // What to do about a host’s failure (#120): the page shows it under the error.
          next: e.status ? e.next : undefined,
        });
      else res.end();
    }
  };
  const server = createServer(handle);

  async function route(req, res) {
    const url = new URL(req.url, origin);
    const path = url.pathname;
    // Postbox listens on localhost only; refuse other hosts (DNS rebinding) and cross-site writes.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
      throw httpError(421, 'Postbox only answers requests addressed to 127.0.0.1 or localhost.');
    if (req.method !== 'GET' && req.headers.origin && !['http://127.0.0.1:' + port, 'http://localhost:' + port].includes(req.headers.origin))
      throw httpError(403, 'Requests from other sites aren’t allowed.');
    // Every write needs the page’s token (#74), except /mcp, where agents call Postbox’s tools with their session.
    if (req.method !== 'GET' && req.method !== 'HEAD' && path !== '/mcp' && !hasToken(req))
      throw Object.assign(
        httpError(
          403,
          'This request came from outside the Postbox page, so Postbox refused it. Changes need the token that only the page you opened has; if this is that page, reload it.',
        ),
        { code: 'token' },
      );

    // While the store can’t be written (#508’s storage design, “When a write fails (ST-3)”), every write is refused here
    // with the cause, before it reaches the runtime; reads, Retry and Stop still answer. The tools have the same gate
    // in server/mcp.mjs.
    if (!store.writable && req.method !== 'GET' && req.method !== 'HEAD' && path !== '/mcp' && path !== '/api/store/retry' && !STOP_ROUTE.test(path))
      throw Object.assign(httpError(503, store.cause?.message ?? 'Postbox can’t save changes right now.'), { code: 'store-closed' });
    if (path === '/api/store/retry' && req.method === 'POST') {
      if (store.writable) throw httpError(409, 'Nothing to retry: Postbox is saving changes. If a page still shows the status line, reload it.');
      await store.reload().catch((e) => {
        throw httpError(503, e.message);
      });
      return send(res, 200, { store: store.status });
    }

    if (path === '/' || path === '/index.html')
      return file(
        res,
        await servedFile(STATIC['/app/'], 'index.html'),
        { ...appHeaders(config), ...(fromBrowser(req) ? { 'set-cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/` } : {}) },
        req,
      );
    if (path === '/favicon.svg') return file(res, await servedFile(BUNDLED_MEDIA, 'favicon.svg'), {}, req);
    if (path === '/kit/workbench.css' || path === '/app/workbench.css')
      return file(res, await servedFile(STATIC['/app/'], 'workbench.css'), { 'access-control-allow-origin': '*' }, req);
    if (path.startsWith('/media/')) {
      const media = await mediaPath(BUNDLED_MEDIA, mediaDir, path.slice('/media/'.length));
      return file(res, media.real, media.bundled ? { 'access-control-allow-origin': '*' } : MEDIA_HEADERS, req);
    }
    for (const [prefix, dir] of Object.entries(STATIC)) {
      if (path.startsWith(prefix))
        return file(res, await servedFile(dir, path.slice(prefix.length)), prefix === '/kit/' ? { 'access-control-allow-origin': '*' } : {}, req);
    }

    // Sandbox frames: agent apps and Mermaid diagrams (server/sandbox-routes.mjs).
    const sandbox = sandboxRoute(store, origin, `http://${host}`, path, url);
    if (sandbox) return raw(res, 200, sandbox.html, sandbox.headers);
    let m;

    if (path === '/mcp') {
      if (req.method !== 'POST') return raw(res, 405, 'Use POST for MCP requests.', { allow: 'POST' });
      const out = await handleMcp(rt, url.searchParams.get('session'), await json(req), url.searchParams.get('turn'), res);
      return out === null ? raw(res, 202, '') : send(res, 200, out);
    }

    if (path === '/api/state' && req.method === 'GET') return send(res, 200, pageState({ store, rt, adapters, origin, demo, real, config, corpus }));
    // What a persona would load, for its sheet: its MCP servers and skills (server/setup-routes.mjs).
    const setupDid = await setupRoute(rt, path, req.method, url, claudeHome);
    if (setupDid) return send(res, setupDid.status, setupDid.body);
    // The permissions panel (#66): one agent’s mode, rules with their sources, folders and tools.
    if (path === '/api/permissions' && req.method === 'GET') {
      const q = (k) => url.searchParams.get(k) || null;
      return send(res, 200, await rt.permissionsView({ sessionId: q('sessionId'), personaId: q('personaId'), projectId: q('projectId') }));
    }
    // The work ledger (#132): where each change stands in git, a file’s diff and a command’s output.
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/work\/git$/)) && req.method === 'GET') return send(res, 200, await rt.workGit(m[1]));
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/work\/files\/([^/]+)\/diff$/)) && req.method === 'GET')
      return send(res, 200, await rt.workDiff(m[1], m[2], url.searchParams.get('change')));
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/work\/commands\/([^/]+)\/output$/)) && req.method === 'GET')
      return raw(res, 200, await rt.workOutput(m[1], m[2]), OUTPUT_HEADERS);
    // A data file an app’s version carries (#54), for the app’s postbox.file(name). Text, never run as a page.
    if ((m = path.match(/^\/api\/apps\/([^/]+)\/files\/([^/]+)$/)) && req.method === 'GET')
      return raw(res, 200, await rt.appFile(decodePath(m[1]), decodePath(m[2]), Number(url.searchParams.get('v')) || undefined), {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'cache-control': 'no-store',
        ...SAME_ORIGIN_ONLY,
      });
    // A review’s image (#780): only a file on that item, by its name and SHA-256; every miss is the same 404.
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/items\/([^/]+)\/files\/([^/]+)$/)) && req.method === 'GET') {
      const served = await servedReviewFile(rt, decodePath(m[1]), decodePath(m[2]), decodePath(m[3]), url.searchParams.get('sha') ?? '');
      if (!served) throw httpError(404, 'That file doesn’t exist.');
      return raw(res, 200, served.bytes, served.headers);
    }
    if (path === '/api/stream' && req.method === 'GET') {
      if (Date.now() < offlineUntil) {
        res.writeHead(503, { 'retry-after': '1' });
        return res.end();
      }
      return stream(req, res, url);
    }

    const body = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' ? (path === '/api/files' ? null : await json(req)) : null;

    if (path === '/api/threads' && req.method === 'POST') return send(res, 201, rt.createThread(body));
    if ((m = path.match(/^\/api\/threads\/([^/]+)$/)) && req.method === 'DELETE') return send(res, 200, rt.deleteThread(m[1]));
    if ((m = path.match(/^\/api\/threads\/([^/]+)$/)) && req.method === 'PATCH') return send(res, 200, patchThread(rt, m[1], body));
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/undo-delete$/)) && req.method === 'POST') {
      rt.undoDeleteThread(m[1]);
      return send(res, 200, { ok: true });
    }
    // A whole conversation, with its side and topic threads (#101).
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/(archive|restore)$/)) && req.method === 'POST') {
      if (m[2] === 'archive') return send(res, 200, { ok: true, archived: rt.archiveThread(m[1]) });
      rt.restoreThread(m[1]);
      return send(res, 200, { ok: true });
    }
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/messages$/)) && req.method === 'POST') return send(res, 201, rt.sendMessage(m[1], body));
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/view$/)) && req.method === 'POST') {
      rt.view(m[1]);
      viewOf(rt).noteWindow(body);
      return send(res, 200, { ok: true });
    }
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/queue\/([^/]+)$/)) && req.method === 'PATCH') {
      rt.editQueued(m[1], m[2], body.text);
      return send(res, 200, { ok: true });
    }
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/queue\/([^/]+)$/)) && req.method === 'DELETE') {
      rt.cancelQueued(m[1], m[2]);
      return send(res, 200, { ok: true });
    }
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/queue\/([^/]+)\/send$/)) && req.method === 'POST') return send(res, 200, rt.sendQueuedNow(m[1], m[2]));
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/items\/([^/]+)\/act$/)) && req.method === 'POST')
      return send(res, 200, await rt.act(m[1], m[2], body.action, body.values ?? {}, body.revision));
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/items\/([^/]+)\/topic$/)) && req.method === 'POST') return send(res, 201, rt.startTopic(m[1], m[2]));
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/items\/([^/]+)\/share$/)) && req.method === 'POST')
      return send(res, 201, rt.shareToConversation(m[1], m[2]));
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/summarize$/)) && req.method === 'POST') return send(res, 200, rt.summarizeBack(m[1], body));
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/items\/([^/]+)\/diagram$/)) && req.method === 'POST')
      return send(res, 200, rt.diagramCheck(m[1], m[2], body));
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/items\/([^/]+)\/dismiss$/)) && req.method === 'POST') return send(res, 200, dismissFailed(rt, m[1], m[2]));
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/items\/([^/]+)\/retry$/)) && req.method === 'POST') {
      await rt.retry(m[1], m[2]);
      return send(res, 200, { ok: true });
    }
    // Resume, after a turn on a host stopped with Sign-in needed or Interrupted (#120): a 409 says why when there’s
    // nothing to resume.
    if ((m = path.match(/^\/api\/sessions\/([^/]+)\/resume$/)) && req.method === 'POST') return send(res, 200, rt.resumeRemote(m[1]));
    // A session’s own actions: Stop, archive, restore, delete, its jobs and its run (server/session-routes.mjs).
    const sessionDid = await sessionRoute(rt, path, req.method, body);
    if (sessionDid) return send(res, sessionDid.status, sessionDid.body);
    // Telemetry: recording a conversation, and its reports (server/telemetry-routes.mjs).
    const telemetryDid = await telemetryRoute(rt, path, req.method, body);
    if (telemetryDid) return send(res, telemetryDid.status, telemetryDid.body);
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/agent-command$/)) && req.method === 'POST') return send(res, 201, rt.runAgentCommand(m[1], body));
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/shell$/)) && req.method === 'POST') {
      shellAllowed(req);
      return send(res, 201, await rt.runShellCommand(m[1], body.command));
    }
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/work\/files\/([^/]+)\/restore$/)) && req.method === 'POST')
      return send(res, 200, await rt.restoreWork(m[1], m[2]));
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/shell\/([^/]+)\/stop$/)) && req.method === 'POST') return send(res, 200, rt.stopShellCommand(m[1], m[2]));
    if (path === '/api/claude-sessions' && req.method === 'GET') return send(res, 200, { sessions: await rt.claudeSessions() });
    if (path === '/api/claude-sessions/attach' && req.method === 'POST') return send(res, 201, await rt.attachClaudeSession(body));
    if (path === '/api/personas' && req.method === 'POST') {
      const p = rt.createPersona(body);
      if (body.join?.threadId) rt.ensureSession(rt.lineage(body.join.threadId).at(-1), p.id, { brief: 'You were just created and added to this thread.' });
      else if (body.join?.projectId) rt.createThread({ projectId: body.join.projectId, title: body.join.title || `With @${p.handle}`, personaIds: [p.id] });
      if (body.saveAsBoilerplate) store.emit('boilerplate', toBoilerplate(p));
      return send(res, 201, p);
    }
    if ((m = path.match(/^\/api\/personas\/([^/]+)$/)) && req.method === 'PATCH') return send(res, 200, rt.updatePersona(m[1], body));
    if (path === '/api/permissions/rules' && req.method === 'POST') return send(res, 200, await rt.changePermissionRule(body));
    if (path === '/api/permissions/folders' && req.method === 'POST') return send(res, 200, await rt.changePermissionFolder(body));
    if (path === '/api/permissions/mode' && req.method === 'POST') return send(res, 200, await rt.setPermissionMode(body.personaId, body.mode));
    // Remote hosts (#120): their routes, reads and writes (server/hosts-routes.mjs).
    const hostsDid = await hostsRoute(rt, path, req.method, body);
    if (hostsDid) return send(res, hostsDid.status, hostsDid.body);
    if (path === '/api/projects' && req.method === 'POST') return send(res, 201, await createProject(store, body));
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/push-url$/)) && req.method === 'PUT') return send(res, 200, setPushUrl(store, m[1], body.url));
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/files$/)) && req.method === 'GET')
      return send(res, 200, await listFolder(store.state.projects[m[1]], url.searchParams.get('path') ?? ''));
    if (path === '/api/files' && req.method === 'POST') return send(res, 201, await upload(req));
    if ((m = path.match(/^\/api\/files\/([^/]+)$/)) && req.method === 'GET') {
      const f = store.state.files[m[1]];
      if (!f) throw httpError(404, 'That file doesn’t exist.');
      // Images from the safe list show inline; everything else downloads. Neither can run script.
      const inline = INLINE_TYPES.has(f.type);
      return raw(res, 200, await blobs.get(f.sha256), {
        'content-type': inline ? f.type : 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^\w.-]/g, '_')}"`,
        'cache-control': 'private, max-age=31536000, immutable',
        ...SAME_ORIGIN_ONLY,
      });
    }
    if (path === '/api/corpus' && req.method === 'POST') {
      const f = store.state.files[body.fileId];
      if (!f) throw httpError(404, 'That file doesn’t exist.');
      if (!/^text\/|\.txt$|\.md$/i.test(f.type + ' ' + f.name)) throw httpError(422, 'Only plain-text and Markdown files can be added to the corpus for now.');
      corpus.addBook(f.id, (await blobs.get(f.sha256)).toString('utf8'), { title: storedName(f.name), author: 'Your file', year: null });
      corpus.reindex();
      store.emit('file', { ...f, inCorpus: true });
      return send(res, 200, { ok: true, corpus: corpus.stats() });
    }
    if ((m = path.match(/^\/api\/apps\/([^/]+)\/(check|event|state|query)$/)) && req.method === 'POST') {
      const id = decodePath(m[1]);
      if (m[2] === 'check') return send(res, 200, rt.appCheck(id, body));
      if (m[2] === 'event') {
        // Rate-limited in the runtime, so a script calling this directly is held to the same limit (#38).
        const r = rt.appEvent(id, body.action, body.values ?? {}, { hold: body.hold === true });
        return send(res, r.held ? 202 : 200, r);
      }
      if (m[2] === 'state') {
        rt.appState(id, body.state);
        return send(res, 200, { ok: true });
      }
      return send(res, 200, { ok: true, result: await rt.appQuery(id, body.tool, body.args ?? {}) });
    }
    if ((m = path.match(/^\/api\/schedules\/([^/]+)\/cancel$/)) && req.method === 'POST') {
      rt.cancelSchedule(m[1]);
      return send(res, 200, { ok: true });
    }
    if (path === '/api/settings' && req.method === 'PUT') {
      const patch = {};
      if ('theme' in body) patch.theme = ['system', 'light', 'dark'].includes(body.theme) ? body.theme : 'system';
      store.emit('settings', patch);
      return send(res, 200, store.state.settings);
    }
    if (demo && path === '/api/demo/offline' && req.method === 'POST') {
      // Drops every live connection and refuses new ones for a while, to show reconnecting.
      offlineUntil = Date.now() + Math.min(60000, Number(body.ms) || 5000);
      for (const r of streams) r.destroy();
      streams.clear();
      return send(res, 200, { ok: true, until: offlineUntil });
    }
    if (demo && path === '/api/demo/speed' && req.method === 'POST') {
      process.env.POSTBOX_MOCK_SPEED = String(Math.max(0.05, Math.min(5, Number(body.speed) || 1)));
      return send(res, 200, { ok: true });
    }
    throw httpError(404, `There’s nothing at ${path}.`);
  }

  async function upload(req) {
    const name = uploadName(decodePath(String(req.headers['x-filename'] ?? 'file')));
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 25 * 1024 * 1024) throw httpError(413, 'Files are limited to 25 MB.');
      chunks.push(c);
    }
    const id = newId('fi');
    const { sha256 } = await blobs.put(Buffer.concat(chunks));
    const f = {
      id,
      name,
      size,
      type: String(req.headers['content-type'] ?? 'application/octet-stream')
        .split(';')[0]
        .trim()
        .slice(0, 100),
      sha256,
      at: Date.now(),
      inCorpus: false,
    };
    store.emit('file', f);
    return { id, name, size, type: f.type, sha256 };
  }

  async function close() {
    stopStreams();
    for (const r of streams) r.destroy();
    for (const t of rt.timers.values()) clearTimeout(t);
    rt.stopMirrors();
    // `!` commands run in their own process groups, so they’d outlive Postbox: SIGINT, then SIGKILL (#67). So do the
    // agents’ CLIs, and the background jobs Postbox kept running (#126, #129).
    await rt.stopShellCommands();
    await rt.stopTurns();
    // After the turns, whose Stop goes to their hosts over these links (#120).
    await stopHosts(hosts, stopWake);
    narrator?.stop();
    await viewOf(rt).close();
    if (server.listening) await new Promise((ok) => server.close(ok));
    await store.close(); // flushes, and releases the data folder’s lock for the next Postbox
  }
  if (listen) await listenServer(server, port, host, close, () => listening(rt)); // drain (#228), then archive (#305)
  const remoteOnly = adapters.names().filter((n) => !adapters.runsHere(n));
  if (!quiet)
    console.log(
      `Postbox is running at ${origin}/\nData: ${dataDir}\nBackends: ${rt.localBackends().join(', ')}${claude ? ` (Claude Code ${claude})` : ''}${kiro ? ` (Kiro CLI ${kiro})` : ''}${agy ? ` (Antigravity CLI ${agy})` : ''}${codex ? ` (Codex ${codex})` : ''}${remoteOnly.length ? `\nOn hosts only: ${remoteOnly.join(', ')}` : ''}${demo ? '\nDemo controls are on.' : ''}`,
    );
  return {
    server,
    rt,
    store,
    origin,
    /** The request handler, for tests that call routes without a network (start({ listen: false })). */
    handle,
    close,
  };
}

/** The person’s files added to the corpus, read back from their blobs at start. O(files). */
async function loadCorpusFiles(store, corpus, blobs) {
  for (const f of Object.values(store.state.files))
    if (f.inCorpus) corpus.addBook(f.id, (await blobs.get(f.sha256)).toString('utf8'), { title: storedName(f.name), author: 'Your file', year: null });
  if (Object.values(store.state.files).some((f) => f.inCorpus)) corpus.reindex();
}

/**
 * Once the server listens: what waited across a restart is drained (#228), then every conversation’s older turns are
 * archived (#305). The archive isn’t awaited, and it never rejects: each pass logs its own failure.
 * @param {any} rt
 */
function listening(rt) {
  rt.drainAll();
  rt.turnArchive.all();
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────────────────

function appHeaders(config) {
  const imgs = config.imageOrigins.filter((o) => o !== config.origin).join(' ');
  return {
    'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${imgs}; font-src 'self'; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

function raw(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  // Bytes, not the string: the socket keeps what it’s given until the page has read it all, and /api/state’s string is
  // as long as the state, two bytes a character once one is past Latin-1. As bytes it leaves the V8 heap at once (#1210).
  res.end(Buffer.from(JSON.stringify(obj)));
}

async function json(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) throw httpError(413, 'That request is larger than 4 MB.');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'The request body isn’t valid JSON.');
  }
}

// Real paths, so a run through a link to the clone starts too.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const { main } = await import('../bin/postbox.mjs');
  await main(process.argv.slice(2), start);
}
