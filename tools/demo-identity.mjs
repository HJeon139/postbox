// A demo of Postbox served to more than one person (#558, prototype), with nothing from AWS: a stand-in for an
// Application Load Balancer that has already signed each person in. It starts a demo Postbox in `alb` identity mode on
// a data folder of its own, serves the balancer’s public key, and opens one address per person. Each address forwards
// to Postbox with `x-amzn-oidc-data` signed as the balancer signs it (ES256, padded base64url, its ARN as `signer`),
// and drops any x-amzn-* header the browser sent, as a balancer does.
//
//   node tools/demo-identity.mjs [--port 4610]
//
// The Postbox port itself answers 401: only the balancer’s addresses know who is asking.

import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4610' } } });
const port = Number(values.port);
const SIGNER = 'arn:aws:elasticloadbalancing:us-west-2:111122223333:loadbalancer/app/postbox-demo/50dc6c495c0c9188';
const PEOPLE = [
  { sub: 'a1b2c3d4-0001', name: 'Dana Ito', email: 'dana@example.com' },
  { sub: 'a1b2c3d4-0002', name: 'Sam Okafor', email: 'sam@example.com' },
];

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const kid = randomUUID();
const b64 = (/** @type {object} */ o) => Buffer.from(JSON.stringify(o)).toString('base64').replaceAll('+', '-').replaceAll('/', '_');
function signedIdentity(/** @type {{ sub: string, name: string, email: string }} */ who) {
  const exp = Math.floor(Date.now() / 1000) + 120;
  const h = b64({ typ: 'JWT', alg: 'ES256', kid, signer: SIGNER, iss: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_demo', client: 'demo', exp });
  const p = b64({ ...who, exp, iss: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_demo' });
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

const servers = [
  createServer((req, res) => {
    if (req.url !== `/${kid}`) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/plain' }).end(publicKey.export({ type: 'spki', format: 'pem' }));
  }).listen(port + 1, '127.0.0.1'),
];

PEOPLE.forEach((who, i) => {
  const at = port + 2 + i;
  servers.push(
    createServer((req, res) => {
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith('x-amzn-')));
      headers.host = `127.0.0.1:${port}`;
      if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
      headers['x-amzn-oidc-data'] = signedIdentity(who);
      const up = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', (e) => res.writeHead(502, { 'content-type': 'text/plain' }).end(`Postbox isn’t answering yet: ${e.message}`));
      res.on('close', () => up.destroy());
      req.pipe(up);
    }).listen(at, '127.0.0.1'),
  );
});

const dataDir = mkdtempSync(join(tmpdir(), 'postbox-identity-demo-'));
const postbox = spawn(process.execPath, [fileURLToPath(new URL('../server/index.mjs', import.meta.url)), '--port', String(port), '--data', dataDir, '--demo'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    POSTBOX_IDENTITY: 'alb',
    POSTBOX_MOCK_PEOPLE: 'Riley Chen',
    POSTBOX_ALB_SIGNER: SIGNER,
    POSTBOX_ALB_KEYS: `http://127.0.0.1:${port + 1}/`,
  },
});
postbox.on('error', (e) => console.error(`Postbox didn’t start: ${e.message}`));

console.log(`Postbox (pid ${postbox.pid}) behind a stand-in load balancer, data in ${dataDir}`);
for (const [i, who] of PEOPLE.entries()) console.log(`  ${who.name}: http://127.0.0.1:${port + 2 + i}/`);
console.log(`  Not signed in (answers 401): http://127.0.0.1:${port}/api/me`);

const stop = () => {
  postbox.kill('SIGINT');
  for (const s of servers) s.close();
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
postbox.on('exit', () => process.exit(0));
