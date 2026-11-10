// #927, the person's follow-ups on #1081: more forms a hook's command can carry a password in, and two that hid what
// they shouldn't. Each is checked on the exact text the panel gets.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readHookFile } from '../server/permission-hooks.mjs';
import { tempDir } from './temp-dirs.mjs';

/** What the panel shows for one command hook. */
async function shownText(command) {
  const file = join(tempDir('pb-hooks-redact-more-'), 'settings.json');
  await writeFile(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }));
  return (await readHookFile(file)).hooks[0].text;
}

test('#927: curl’s bundled short flags ending in -u hide the password, and keep the user', async () => {
  assert.equal(await shownText('curl -su user:S3CRET https://x'), 'curl -su user:… https://x');
  assert.equal(await shownText('curl -sSkuadmin:pw&&ok'), 'curl -sSkuadmin:…&&ok');
  assert.equal(await shownText('curl -su "me:p w<&" -o out'), 'curl -su "me:…" -o out');
  // Only curl’s: another command’s bundle ending in u is left as written, as before.
  assert.equal(await shownText('ls -lu x:y; curl -su a:b x'), 'ls -lu x:y; curl -su a:… x');
  const others = 'ls -lu "x:y"; xcurl -su a:b; curly -su c:d';
  assert.equal(await shownText(others), others, 'quoted, or a command that only contains curl in its name');
});

test('#927: curl’s -U and --proxy-user hide the proxy password, quoted or not', async () => {
  assert.equal(await shownText('curl -U proxy:S3CRET -x http://p https://x'), 'curl -U proxy:… -x http://p https://x');
  assert.equal(await shownText('curl --proxy-user "me:p\\"w" -s'), 'curl --proxy-user "me:…" -s');
  assert.equal(await shownText('curl --proxy-user=me:pw x'), 'curl --proxy-user=me:… x');
  assert.equal(await shownText('pip install -U pkg; tool --proxy-users a:b'), 'pip install -U pkg; tool --proxy-users a:b', 'no colon, or another flag');
});

test('#927: a URL after -u, and a host named like a token, lose nothing', async () => {
  const cmd =
    'tool -u https://x.example/y && tool -u "https://x/y" && curl http://token-gate:8088/hook && wget https://api-key.example:443/a && redis-cli -h token-cache:6379';
  assert.equal(await shownText(cmd), cmd);
});

test('#927: an unquoted Cookie header hides its cookies only to the end of its word, not the rest of the command', async () => {
  // The shell's own escapes keep the word going: an escaped space and ; are part of the cookie, the next space ends it.
  assert.equal(await shownText('curl -H Cookie:\\ a=1\\;b=2 https://x && rm -rf /tmp/foo'), 'curl -H Cookie:… https://x && rm -rf /tmp/foo');
  assert.equal(await shownText('curl -H cookie:a=1;echo done'), 'curl -H cookie:…;echo done');
  // Quoted, it still hides to the quote that closes the header, past spaces and ;.
  assert.equal(await shownText("curl -H 'Cookie: a=1; b=2' x && ok"), "curl -H 'Cookie: …' x && ok");
});
