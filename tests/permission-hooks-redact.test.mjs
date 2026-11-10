// #817: the permissions panel lists each PreToolUse hook’s command, and GET /api/permissions carries it to the page.
// A command can hold a credential, so the reader hides values named like a key, token, secret or password, and
// bearer tokens, before the text leaves the server. It’s best effort: each test checks the exact string it hands on.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readHookFile } from '../server/permission-hooks.mjs';
import { tempDir } from './temp-dirs.mjs';

/** What the panel shows for one command hook, or for `hook` as given. */
async function shownText(hook) {
  const file = join(tempDir('pb-hooks-redact-'), 'settings.json');
  const h = typeof hook === 'string' ? { type: 'command', command: hook } : hook;
  await writeFile(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [h] }] } }));
  return (await readHookFile(file)).hooks[0].text;
}

test('#817: a bearer token in a hook command is hidden, in any case, and the rest of the command stays', async () => {
  assert.equal(
    await shownText('curl -H "Authorization: Bearer sk-abc.def" https://audit.example/log'),
    'curl -H "Authorization: Bearer …" https://audit.example/log',
  );
  assert.equal(await shownText("curl -H 'authorization: bearer eyJhbGc.x.y' -d @-"), "curl -H 'authorization: bearer …' -d @-");
});

test('#817: env assignments named like a key, token, secret or password hide their values, quoted or not', async () => {
  assert.equal(
    await shownText('API_KEY=sk-1 GITHUB_TOKEN=\'gh p\' db_password="a b\\" c" Client_Secret=s node hook.js'),
    'API_KEY=… GITHUB_TOKEN=… db_password=… Client_Secret=… node hook.js',
  );
});

test('#817: a --flag=value or --flag value named like a credential hides its value, and the next flag stays', async () => {
  assert.equal(await shownText('guard --api-key=sk-2 --token sk-3 --password "p w" --verbose'), 'guard --api-key=… --token … --password … --verbose');
  assert.equal(await shownText('guard --token --verbose'), 'guard --token --verbose', 'a flag followed by a flag has no value to hide');
});

test('#817: a credential value ends where the shell ends a word: at &, ;, |, < or >', async () => {
  assert.equal(await shownText('SECRET=a&&echo ok; TOKEN=b|tee x; KEY=c<in >out'), 'SECRET=…&&echo ok; TOKEN=…|tee x; KEY=…<in >out');
});

test('#817: an unterminated quote hides the rest of the command, so a secret after it can’t show', async () => {
  assert.equal(await shownText('X_TOKEN="abc def && echo done'), 'X_TOKEN=…');
  assert.equal(await shownText("run --secret 'abc def"), 'run --secret …');
});

test('#817: markup and quotes around a credential stay text, and the value is still hidden', async () => {
  assert.equal(
    await shownText('echo "<img src=x onerror=alert(1)>" && PASSWORD=\'<b>&amp;</b>\' run'),
    'echo "<img src=x onerror=alert(1)>" && PASSWORD=… run',
  );
});

test('#817: a token in an http hook’s address is hidden too', async () => {
  assert.equal(await shownText({ type: 'http', url: 'https://hooks.example/x?token=abc&v=1' }), 'https://hooks.example/x?token=…&v=1');
});

test('#817: a command with no credential in it is listed exactly as written', async () => {
  const cmd = 'NODE_ENV=production npm test -- --reporter dot && echo "done: $?"';
  assert.equal(await shownText(cmd), cmd);
});

test('#871: a credential in a hook’s matcher is hidden too, as in its command, and the rest of the matcher stays', async () => {
  const file = join(tempDir('pb-hooks-redact-'), 'settings.json');
  const matcher = 'Bash|mcp__api__.*|api_key=sk-9|Bearer abc.def';
  await writeFile(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: 'audit' }] }] } }));
  assert.equal((await readHookFile(file)).hooks[0].matcher, 'Bash|mcp__api__.*|api_key=…|Bearer …');
});

test('#871: a matcher with no credential in it, or a tool name with key or token in it, is listed exactly as written', async () => {
  const file = join(tempDir('pb-hooks-redact-'), 'settings.json');
  const matcher = 'mcp__keys__get_token|Write|Edit';
  await writeFile(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: 'audit' }] }] } }));
  assert.equal((await readHookFile(file)).hooks[0].matcher, matcher);
});

// #927: more credential shapes. The made-up tokens are put together here, so no line of this file holds one whole.
const GH = `ghp_${'A1b2'.repeat(9)}`;
const PAT = `github_pat_${'11AB_cd'.repeat(6)}`;
const SK = `sk-proj-${'Z9y8'.repeat(6)}`;
const XOX = `xoxb-${'1234-5678'.repeat(2)}`;
const AWS = `AKIA${'ABCD2345'.repeat(2)}`;
const GLPAT = `glpat-${'x1Y2'.repeat(5)}`;
const JWT = `eyJ${'hbGciOiJ'}.eyJ${'zdWIiOjE'}.${'c2lnbmF0'.repeat(2)}`;

test('#927: a URL’s userinfo is hidden, a user and password or a token alone, and the host and path stay', async () => {
  assert.equal(await shownText({ type: 'http', url: 'https://user:pass@hooks.example/x' }), 'https://…@hooks.example/x');
  assert.equal(await shownText(`git clone https://bot:${GH}@github.com/o/r.git && echo ok`), 'git clone https://…@github.com/o/r.git && echo ok');
  assert.equal(await shownText(`curl "https://${GH}@h.example/x"<in&`), 'curl "https://…@h.example/x"<in&');
  assert.equal(await shownText('\0ftp://u:p@h.example/\0'), '\uFFFDftp://…@h.example/\uFFFD');
});

test('#927: a URL without userinfo, an @ in its path, and a scp-style git address are listed exactly as written', async () => {
  const cmd = 'curl https://example.com/a@b?q=1 && git clone git@github.com:o/r.git && mail me@example.com';
  assert.equal(await shownText(cmd), cmd);
});

test('#927: an Authorization header hides its credential under any scheme, or none, and keeps the scheme', async () => {
  assert.equal(await shownText("curl -H 'Authorization: Basic dXNlcjpwYXNz' https://x"), "curl -H 'Authorization: Basic …' https://x");
  assert.equal(await shownText(`curl -H "Authorization: token ${GH}" -d @-`), 'curl -H "Authorization: token …" -d @-');
  assert.equal(await shownText(`curl -H "authorization:${SK}"<in`), 'curl -H "authorization:…"<in');
  assert.equal(await shownText('curl -H Authorization:abc123;ok'), 'curl -H Authorization:…;ok');
  assert.equal(await shownText('curl -H Authorization:FAKEVALUE123 https://audit.example/log'), 'curl -H Authorization:… https://audit.example/log');
  assert.equal(await shownText('curl -H "Authorization:FAKEVALUE123 rest" ok'), 'curl -H "Authorization:…" ok');
  assert.equal(await shownText('curl -H "Proxy-Authorization: Basic abc&def"'), 'curl -H "Proxy-Authorization: Basic …"');
});

test('#927: a quoted Authorization header with parameters hides all of them, to the quote that ends the header', async () => {
  const digest = 'curl -H "Authorization: Digest username=\\"u\\", response=\\"abc\\"" -H "Accept: */*" https://x';
  assert.equal(await shownText(digest), 'curl -H "Authorization: Digest …" -H "Accept: */*" https://x');
  const sigv4 = `curl -H 'Authorization: AWS4-HMAC-SHA256 Credential=${AWS}/2020/us/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=deadbeef' -s`;
  assert.equal(await shownText(sigv4), "curl -H 'Authorization: AWS4-HMAC-SHA256 …' -s");
  assert.equal(await shownText('curl -H \'authorization: Digest a="<&", r="x"\' ok'), "curl -H 'authorization: Digest …' ok");
  assert.equal(await shownText('curl -H "Authorization: Basic a\0b" ok'), 'curl -H "Authorization: Basic …" ok');
  assert.equal(await shownText('curl -H "Authorization: Basic abc\nnext line'), 'curl -H "Authorization: Basic …', 'a quote that never closes hides the rest');
});

test('#927: curl’s -u and --user hide the password after the user’s colon, quoted or not, and keep the user', async () => {
  assert.equal(await shownText('curl -u user:S3CRET https://x'), 'curl -u user:… https://x');
  assert.equal(await shownText('curl -uadmin:pw&&ok'), 'curl -uadmin:…&&ok');
  assert.equal(await shownText('curl --user "me:p w<&" -s'), 'curl --user "me:…" -s');
  assert.equal(await shownText("curl --user='me:p\"w' -s"), "curl --user='me:…' -s");
  assert.equal(await shownText('curl -u :token https://x'), 'curl -u :… https://x');
  assert.equal(await shownText('curl --user=me:pw -u me:p:w --user "me:p:w" x'), 'curl --user=me:… -u me:… --user "me:…" x');
});

test('#927: a -u or --user with no colon, and -u inside another word, are listed exactly as written', async () => {
  const cmd = 'sudo -u root cmd --user alice; ls -lu x:y; tool --users a:b; pkg-ufoo:bar; pkg-u"a:b"';
  assert.equal(await shownText(cmd), cmd);
});

test('#927: a header named like a key, token, secret or password hides its value, quoted or not', async () => {
  assert.equal(await shownText('curl -H "X-Api-Key: abc123" https://x'), 'curl -H "X-Api-Key: …" https://x');
  assert.equal(await shownText('curl -H X-Api-Key:abc<in&&ok'), 'curl -H X-Api-Key:…<in&&ok');
  assert.equal(await shownText('curl -H \'Private-Token: "a b"\''), "curl -H 'Private-Token: …'");
  assert.equal(await shownText('curl -H "X-Auth-Token: abc\0rest"'), 'curl -H "X-Auth-Token: …"');
});

test('#927: a Cookie header hides every cookie in it, to the end of its quoted header', async () => {
  assert.equal(await shownText("curl -H 'Cookie: session=abc; csrf=def' https://x"), "curl -H 'Cookie: …' https://x");
  assert.equal(await shownText('curl -H "cookie:a=b<c&d" -s'), 'curl -H "cookie:…" -s');
});

test('#927: headers that carry no credential, and a word before a colon in prose, are listed exactly as written', async () => {
  const cmd = 'curl -H "Content-Type: application/json" -H "Accept: */*" && echo "Authorization required: $?"';
  assert.equal(await shownText(cmd), cmd);
});

test('#927: a JSON field named like a key, token, secret or password hides its string value, escaped or not', async () => {
  assert.equal(await shownText(`curl -d '{"token":"abc","n":1}' https://x`), `curl -d '{"token":"…","n":1}' https://x`);
  assert.equal(await shownText('send {"password": "p\\"w<&", "user": "me"}'), 'send {"password": "…", "user": "me"}');
  assert.equal(await shownText('curl -d "{\\"apiKey\\": \\"abc\\"}"'), 'curl -d "{\\"apiKey\\": \\"…\\"}"');
  assert.equal(await shownText('send {"secret":"s\0t"}'), 'send {"secret":"…"}');
  assert.equal(await shownText('send {"client_secret": "never closed'), 'send {"client_secret": "…');
});

test('#927: a JSON field whose value isn’t a string, or whose name names no credential, is listed exactly as written', async () => {
  const cmd = 'send {"tokens": 5, "keyboard": true, "token": null, "user": "pat"}';
  assert.equal(await shownText(cmd), cmd);
});

test('#927: a query parameter that carries a signature or a credential under another name hides its value', async () => {
  assert.equal(await shownText({ type: 'http', url: 'https://hooks.example/x?sig=abc&v=1' }), 'https://hooks.example/x?sig=…&v=1');
  assert.equal(
    await shownText({ type: 'http', url: 'https://b.example/o?X-Amz-Credential=AK%2F1&X-Amz-Signature=f00d#top' }),
    'https://b.example/o?X-Amz-Credential=…&X-Amz-Signature=…#top',
  );
  assert.equal(
    await shownText({ type: 'http', url: 'https://g.example/o?X-Goog-Credential=k%2F1&X-Goog-Signature=f00d&signature=e1' }),
    'https://g.example/o?X-Goog-Credential=…&X-Goog-Signature=…&signature=…',
  );
  assert.equal(await shownText('curl "https://h.example/?auth=a<b"&&ok'), 'curl "https://h.example/?auth=…<b"&&ok');
});

test('#927: query parameters named like none of those are listed exactly as written', async () => {
  const url = 'https://h.example/x?sigma=1&page=2&author=me&signal=on';
  assert.equal(await shownText({ type: 'http', url }), url);
});

test('#927: a bare token with a known prefix is hidden alone', async () => {
  for (const token of [GH, PAT, SK, XOX, AWS, GLPAT, JWT]) assert.equal(await shownText(token), '…', token.slice(0, 6));
});

test('#927: a bare token is hidden inside a longer command, and the quotes, markup and marks around it stay', async () => {
  assert.equal(await shownText(`echo ${GH}|gh auth login --with-token`), 'echo …|gh auth login --with-token');
  assert.equal(await shownText(`run "${SK}" <${AWS}> &${XOX}&`), 'run "…" <…> &…&');
  assert.equal(await shownText(`login ${GLPAT}\0${JWT}\0`), 'login …\uFFFD…\uFFFD');
  assert.equal(await shownText(`gh --hostname h.example ${PAT} && echo ok`), 'gh --hostname h.example … && echo ok');
});

test('#927: a word that only starts like a token, or a prefix alone, is listed exactly as written', async () => {
  const cmd = 'skeleton ghp ghp_short sk-1 task-abcdefghijklmnopqrstuvwxyz AKIA eyJ glpat- glpat-short noglpat-abcdefghijklmnopqrstu xoxb- github_pat_';
  assert.equal(await shownText(cmd), cmd);
});

test('#927: overlapping shapes hide every credential once, and keep each name', async () => {
  assert.equal(await shownText({ type: 'http', url: `https://user:${GH}@h.example/x?token=${GH}&sig=abc` }), 'https://…@h.example/x?token=…&sig=…');
  assert.equal(await shownText(`curl -H "Authorization: Bearer ${JWT}"`), 'curl -H "Authorization: Bearer …"');
  assert.equal(await shownText(`GITHUB_TOKEN=${GH} --password ${SK} gh`), 'GITHUB_TOKEN=… --password … gh');
  assert.equal(await shownText(`send '{"token":"Bearer ${SK}"}'`), `send '{"token":"…"}'`);
  assert.equal(await shownText(`curl -H "X-Api-Key: ${AWS}" -H 'Cookie: token=${GH}; a=b'`), `curl -H "X-Api-Key: …" -H 'Cookie: …'`);
});

test('#927: a character that shows as nothing before = still lets the name be read, and is marked', async () => {
  assert.equal(await shownText('api_key\u200B=sk-1 run'), 'api_key\uFFFD=… run');
  assert.equal(await shownText('GITHUB_\u2060TOKEN=abc run'), 'GITHUB_\uFFFDTOKEN=… run');
});

test('#927: names full of invisible marks are read in linear time, so a hostile settings file can’t stall the server', async () => {
  const hooks20 = ['\u200bkey', '\u200b--key'].flatMap((part) => Array(10).fill({ type: 'command', command: part.repeat(500) }));
  const file = join(tempDir('pb-hooks-redact-'), 'settings.json');
  await writeFile(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: hooks20 }] } }));
  const start = performance.now();
  const { hooks } = await readHookFile(file);
  const ms = performance.now() - start;
  assert.equal(hooks.length, 20);
  assert.ok(ms < 1000, `${Math.round(ms)} ms for 20 hooks`);
  assert.equal(await shownText('\u200bMY\u200bTOKEN=s3cret ok'), '\ufffdMY\ufffdTOKEN=… ok', 'a name with marks is still hidden');
});
