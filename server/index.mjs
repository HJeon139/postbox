// Postbox server: serves the app, the API, live updates over server-sent events, the MCP endpoint and
// the sandbox frames for agent-written apps. Node only, no dependencies.
//
//   node server/index.mjs [--port 4173] [--data <folder>] [--fresh] [--demo]
//
// The same as the postbox command (bin/postbox.mjs), which reads the flags and finds the data folder (server/home.mjs).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { AdapterRegistry } from './adapters/adapter.mjs';
import { mcpServerList, yourMcpServers } from './adapters/mcp-config.mjs';
import { MockAdapter } from './adapters/mock.mjs';
import { DEFAULT_EFFORT, EFFORT_LEVELS, REAL_BACKEND_TOOLS } from './adapters/setup.mjs';
import { PROBES, registerBackends } from './backends.mjs';
import { Blobs, INLINE_TYPES } from './blobs.mjs';
import { buildInfo } from './build-info.mjs';
import { Corpus } from './corpus.mjs';
import { listFolder } from './folders.mjs';
import { dataFolder } from './home.mjs';
import { handleMcp } from './mcp.mjs';
import { Narrator, narrationInstalled } from './narration/narrator.mjs';
import { hostManagerFor, startHosts, stopHosts } from './remote/serve.mjs';
import { DEFAULT_MODEL, HOP_LIMIT, httpError, PERMISSION_MODES, Runtime } from './runtime.mjs';
import { mermaidPage, sandboxPage } from './sandbox.mjs';
import { KNOWN_TOOLS, seed, toBoilerplate } from './seed.mjs';
import { decodePath, mediaPath, servedFile } from './served-files.mjs';
import { sessionRoute } from './session-routes.mjs';
import { isLoopback } from './shell.mjs';
import { newId, Store } from './store.mjs';
import { recordingOff, watchTelemetry } from './telemetry.mjs';
import { telemetryRoute } from './telemetry-routes.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
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

/**
 * @param {{ port?: number, dataDir?: string, fresh?: boolean, demo?: boolean, quiet?: boolean, claudeHome?: string, listen?: boolean,
 *           host?: string, spawnShell?: typeof import('node:child_process').spawn, hosts?: import('./remote/hosts.mjs').HostManager|null,
 *           wake?: Parameters<typeof import('./remote/wake.mjs').watchWake>[1], probes?: Partial<typeof PROBES> }} [opts]
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
} = {}) {
  const origin = `http://127.0.0.1:${port}`;
  process.env.POSTBOX_ORIGIN = origin;
  // Agents copy the images their apps show here; show_app’s description names the variable.
  const mediaDir = join(dataDir, 'media');
  await mkdir(mediaDir, { recursive: true });
  process.env.POSTBOX_MEDIA = mediaDir;
  if (fresh)
    for (const n of await readdir(dataDir).catch(() => []))
      if (/^(store\.json|snapshot\.json|events-\d+\.jsonl)/.test(n)) await rm(join(dataDir, n), { force: true });
  const store = await new Store(dataDir).load();
  const blobs = new Blobs(join(dataDir, 'blobs'));
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
  };
  // Kokoro is optional; without it, narration says it isn’t installed.
  const narrator = narrationInstalled() ? new Narrator({ modelsDir: join(dataDir, 'models'), blobs }) : null;
  // The hosts’ links (#120), made on first use (server/remote/serve.mjs).
  const hosts = hostManagerFor(given, () => rt, dataDir, config.build.version);
  const rt = new Runtime({ store, adapters, corpus, config, blobs, narrator, spawnShell, hosts });
  // Recording conversations for telemetry, and its 30-day sweep (designs/telemetry-persona.md, R7, R11).
  watchTelemetry(rt);
  const firstReal = ['claude-code', 'agent-sdk', 'kiro-cli', 'antigravity-cli', 'codex'].find((b) => adapters.runsHere(b)) ?? 'mock';
  await seed(rt, { dataDir, booksDir: join(ROOT, 'server', 'corpus', 'books'), backend: firstReal, demo });
  // Turns that were running when the server stopped can’t resume; mark them so nothing looks stuck.
  for (const se of Object.values(store.state.sessions))
    if (['think', 'gen', 'tool', 'stopping'].includes(se.state))
      rt.updateSession(se.id, { state: 'idle', subagents: [], currentStep: 'Interrupted by a restart', stopAsk: null });
  for (const [threadId, list] of Object.entries(store.state.items))
    for (const it of list) if (it.status === 'streaming') rt.patchItem(threadId, it.id, { status: 'stopped' });
  rt.rearmSchedules();
  rt.rearmDeletions();
  rt.expireStalePermissions();
  rt.expireStaleCommands();
  rt.ledger.expireStale();
  rt.expireStaleJobs();
  rt.rearmMirrors();
  // Turns that went on on their hosts are attached again, each host’s status is kept for the page, and the hosts
  // reconnect when this computer wakes (#120).
  const stopWake = startHosts(rt, hosts, wake);
  for (const f of Object.values(store.state.files))
    if (f.inCorpus) corpus.addBook(f.id, (await blobs.get(f.sha256)).toString('utf8'), { title: f.name, author: 'Your file', year: null });
  if (Object.values(store.state.files).some((f) => f.inCorpus)) corpus.reindex();
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

  const streams = new Set();
  let offlineUntil = 0;
  // POSTBOX_STREAM_LAG holds every event back that many milliseconds, as a busy computer can. The browser specs run
  // with it in CI to show they wait for the page to hear a change, not for a fixed time.
  const lag = Number(process.env.POSTBOX_STREAM_LAG) || 0;
  store.subscribe((ev) => {
    const line = `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`;
    const send = () => {
      for (const res of streams) res.write(line);
    };
    if (lag > 0) setTimeout(send, lag).unref();
    else send();
  });
  const keepAlive = setInterval(() => {
    for (const res of streams) res.write(': keep-alive\n\n');
  }, 15000);

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

    // Sandbox frames: agent apps and Mermaid diagrams. Each is its own page with a strict policy and,
    // because the iframe is sandboxed without allow-same-origin, an opaque origin.
    let m;
    if ((m = path.match(/^\/sandbox\/app\/([^/]+)\/(\d+)$/))) {
      const app = store.state.apps[decodePath(m[1])];
      const v = app?.versions[+m[2] - 1];
      if (!v) throw httpError(404, 'That app version doesn’t exist.');
      const page = sandboxPage({
        origin,
        app,
        version: v,
        theme: url.searchParams.get('theme') === 'light' ? 'light' : 'dark',
        check: url.searchParams.has('check'),
      });
      return raw(res, 200, page.html, {
        'content-type': TYPES['.html'],
        'content-security-policy': page.csp,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
    }
    if (path === '/sandbox/mermaid') {
      const page = mermaidPage({ origin, theme: url.searchParams.get('theme') === 'light' ? 'light' : 'dark' });
      return raw(res, 200, page.html, { 'content-type': TYPES['.html'], 'content-security-policy': page.csp, 'cache-control': 'no-store' });
    }

    if (path === '/mcp') {
      if (req.method !== 'POST') return raw(res, 405, 'Use POST for MCP requests.', { allow: 'POST' });
      const out = await handleMcp(rt, url.searchParams.get('session'), await json(req), url.searchParams.get('turn'), res);
      return out === null ? raw(res, 202, '') : send(res, 200, out);
    }

    if (path === '/api/state' && req.method === 'GET') {
      return send(res, 200, {
        seq: store.state.seq,
        state: store.state,
        config: {
          origin,
          hopLimit: HOP_LIMIT,
          // Postbox’s tools, then those only real backends have (#5).
          knownTools: [...KNOWN_TOOLS, ...REAL_BACKEND_TOOLS],
          // The backends that run on this computer.
          adapters: rt.localBackends(),
          // What each one can do (#117), so the page hides what a backend can’t honor rather than checking its name;
          // local: whether it runs on this computer, since one that can run on a host is listed without its CLI here.
          backends: Object.fromEntries(adapters.names().map((n) => [n, { ...(adapters.get(n).capabilities ?? {}), local: adapters.runsHere(n) }])),
          defaultModel: DEFAULT_MODEL,
          effortLevels: EFFORT_LEVELS,
          defaultEffort: DEFAULT_EFFORT,
          permissionModes: PERMISSION_MODES,
          demo,
          // Whether Postbox looked for real backends, and the Claude Code it found: if none, the overview says how (#12).
          realBackends: real,
          recordingOff: recordingOff(rt),
          versions: config.versions,
          build: config.build,
          corpus: corpus.stats(),
        },
      });
    }
    // The MCP servers a persona would load, with their status (#59): names, scopes and statuses only, never config.
    if (path === '/api/mcp-servers' && req.method === 'GET') {
      const { persona, folder, seen } = rt.mcpContext(url.searchParams.get('personaId'), url.searchParams.get('projectId'));
      const found = await yourMcpServers(folder, { home: claudeHome });
      return send(res, 200, { folder, servers: mcpServerList({ found, seen, off: persona?.mcpOff ?? [] }) });
    }
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
      return raw(res, 200, await rt.workOutput(m[1], m[2]), { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
    // A data file an app’s version carries (#54), for the app’s postbox.file(name). Text, never run as a page.
    if ((m = path.match(/^\/api\/apps\/([^/]+)\/files\/([^/]+)$/)) && req.method === 'GET')
      return raw(res, 200, await rt.appFile(decodePath(m[1]), decodePath(m[2]), Number(url.searchParams.get('v')) || undefined), {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'cache-control': 'no-store',
      });
    if ((m = path.match(/^\/api\/hosts\/([^/]+)\/install$/)) && req.method === 'GET') return send(res, 200, await rt.describeHostInstall(m[1]));
    if ((m = path.match(/^\/api\/hosts\/([^/]+)\/status$/)) && req.method === 'GET') return send(res, 200, { status: rt.hostStatus(m[1]) });
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
    if ((m = path.match(/^\/api\/threads\/([^/]+)$/)) && req.method === 'PATCH') return send(res, 200, rt.renameThread(m[1], body.title));
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
    // Remote hosts (#120): add, change and remove one, a project’s folder on one, installing Postbox’s host program
    // (the page shows the GET’s text and asks first), connecting again, and the connection’s status. The hosts and
    // their status are also in /api/state, kept current by 'host' and 'host.status' events.
    if (path === '/api/hosts' && req.method === 'POST') return send(res, 201, rt.addHost(body));
    if ((m = path.match(/^\/api\/hosts\/([^/]+)$/)) && req.method === 'PATCH') return send(res, 200, rt.updateHost(m[1], body));
    if ((m = path.match(/^\/api\/hosts\/([^/]+)$/)) && req.method === 'DELETE') return send(res, 200, await rt.removeHost(m[1]));
    if ((m = path.match(/^\/api\/hosts\/([^/]+)\/install$/)) && req.method === 'POST') return send(res, 200, await rt.installHost(m[1]));
    if ((m = path.match(/^\/api\/hosts\/([^/]+)\/retry$/)) && req.method === 'POST')
      return send(res, 200, rt.retryHost(m[1], { takeover: body.takeover ?? false }));
    if ((m = path.match(/^\/api\/projects\/([^/]+)\/hosts\/([^/]+)\/folder$/)) && req.method === 'PUT')
      return send(res, 200, rt.setProjectHostFolder(m[1], m[2], body.folder));
    if (path === '/api/projects' && req.method === 'POST') {
      const folder = resolve(String(body.folder ?? ''));
      const st = await stat(folder).catch(() => null);
      if (!st?.isDirectory()) throw httpError(422, 'That folder doesn’t exist. Pick an existing folder for the project.');
      const p = { id: newId('pr'), name: String(body.name || 'New project').slice(0, 80), folder };
      store.emit('project', p);
      return send(res, 201, p);
    }
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
      });
    }
    if (path === '/api/corpus' && req.method === 'POST') {
      const f = store.state.files[body.fileId];
      if (!f) throw httpError(404, 'That file doesn’t exist.');
      if (!/^text\/|\.txt$|\.md$/i.test(f.type + ' ' + f.name)) throw httpError(422, 'Only plain-text and Markdown files can be added to the corpus for now.');
      corpus.addBook(f.id, (await blobs.get(f.sha256)).toString('utf8'), { title: f.name, author: 'Your file', year: null });
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

  function stream(req, res, url) {
    const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? store.state.seq);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 1500\n\n');
    const backlog = store.since(since);
    // Too far behind: the browser refetches the whole state, then resumes from its sequence number.
    if (backlog === null) res.write(`event: resync\ndata: {}\n\n`);
    else for (const ev of backlog) res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    streams.add(res);
    req.on('close', () => streams.delete(res));
  }

  async function upload(req) {
    const name =
      decodePath(String(req.headers['x-filename'] ?? 'file'))
        .replace(/[\\/]/g, '_')
        .slice(0, 200) || 'file';
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
    clearInterval(keepAlive);
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
    if (server.listening) await new Promise((ok) => server.close(ok));
    await store.flush();
  }
  if (listen)
    await new Promise((ok, fail) => {
      server.once('error', (e) => close().then(() => fail(e), fail)); // a taken port closes all this first, so a caller can retry (#367)
      server.listen(port, host, () => ok(rt.drainAll())); // listening: what waited in the queues across a restart goes (#228)
    });
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

// ── HTTP helpers ─────────────────────────────────────────────────────────────────────────

function appHeaders(config) {
  const imgs = config.imageOrigins.filter((o) => o !== config.origin).join(' ');
  return {
    'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${imgs}; font-src 'self'; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

// Static files carry an ETag, so a reload revalidates cheaply (304) instead of downloading everything,
// and text is gzipped when the browser accepts it. Both are cached in memory by path and modification time.
const staticCache = new Map();
/** @param {import('node:http').ServerResponse} res @param {string} path @param {Record<string, string>} [headers] @param {import('node:http').IncomingMessage|null} [req] */
async function file(res, path, headers = {}, req = null) {
  let st;
  try {
    st = await stat(path);
  } catch {
    throw httpError(404, 'Not found.');
  }
  if (!st.isFile()) throw httpError(404, 'Not found.');
  let entry = staticCache.get(path);
  if (!entry || entry.mtime !== st.mtimeMs) {
    const data = await readFile(path);
    const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
    const compressible = /^(text\/|application\/json|image\/svg)/.test(type) && data.length > 1024;
    entry = { mtime: st.mtimeMs, data, type, etag: `"${createHash('sha1').update(data).digest('base64url')}"`, gz: compressible ? gzipSync(data) : null };
    staticCache.set(path, entry);
  }
  const base = {
    'content-type': entry.type,
    'cache-control': 'no-cache',
    etag: entry.etag,
    'x-content-type-options': 'nosniff',
    vary: 'accept-encoding',
    ...headers,
  };
  if (req?.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, base);
    res.end();
    return;
  }
  const gzip = entry.gz && /\bgzip\b/.test(req?.headers['accept-encoding'] ?? '');
  res.writeHead(200, { ...base, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
  res.end(gzip ? entry.gz : entry.data);
}

function raw(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
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
