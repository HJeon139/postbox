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
