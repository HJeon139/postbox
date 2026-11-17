// A stand-in for “another site” and for a server on the local network, for the flexible-apps prototype’s security
// probes (designs/prototypes/flexible-apps.md). It serves nothing real: /login sets cookies as a site you’re signed into
// would, /probe/<id> records whether a request reached it and with which cookies, /seen/<id> reports that to anyone,
// and /data.json is public data with CORS open. Run: node tools/probe-site.mjs [--port 4518] [--lan <address>]

import http from 'node:http';

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const port = Number(opt('--port', 4518));
const lan = opt('--lan', null);
const seen = new Map();

const DATA = {
  x: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'],
  series: [
    { name: 'Visits', values: [120, 135, 160, 150, 190, 230, 260, 245] },
    { name: 'Sign-ups', values: [12, 18, 15, 22, 30, 41, 38, 44] },
  ],
};

function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const m = url.pathname.match(/^\/(probe|seen)\/([\w-]+)$/);
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}${url.search} ua=${String(req.headers['user-agent']).slice(-60)}`);
  if (url.pathname === '/login') {
    res.writeHead(200, {
      'set-cookie': [
        'sid=signed-in-secret; SameSite=None; Secure; Path=/',
        'lax=lax-secret; SameSite=Lax; Path=/',
        'strict=strict-secret; SameSite=Strict; Path=/',
      ],
      'content-type': 'text/html; charset=utf-8',
    });
    return res.end('<!doctype html><title>Stand-in site</title><p>You’re signed in to the stand-in site.</p>');
  }
  if (url.pathname === '/data.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(DATA));
  }
  if (m?.[1] === 'probe') {
    seen.set(m[2], {
      hit: true,
      method: req.method,
      cookie: req.headers.cookie ?? '',
      origin: req.headers.origin ?? '',
      site: req.headers['sec-fetch-site'] ?? '',
    });
    console.log(
      `probe ${m[2]} ${req.method} cookie=${req.headers.cookie ?? '-'} origin=${req.headers.origin ?? '-'} site=${req.headers['sec-fetch-site'] ?? '-'}`,
    );
    // No CORS headers, as a real site’s private API sends none: a browser shouldn’t let another origin read this.
    res.writeHead(200, { 'content-type': m[2].endsWith('-js') ? 'text/javascript' : 'text/plain' });
    return res.end(m[2].endsWith('-js') ? 'window.__probeScriptRan = true;' : `private data for ${req.headers.cookie ?? 'nobody'}`);
  }
  if (m?.[1] === 'seen') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(seen.get(m[2]) ?? { hit: false }));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>Stand-in site</title><p>The stand-in for another site.</p>');
}

for (const host of ['127.0.0.1', ...(lan ? [lan] : [])])
  http.createServer(handle).listen(port, host, () => console.log(`probe site on http://${host}:${port}`));
