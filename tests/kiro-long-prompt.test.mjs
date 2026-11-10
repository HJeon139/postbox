// #362 item 5: Kiro gets its prompt as an argument, and Linux refuses one argument past 128 KiB (E2BIG), so a long
// wake failed to start. Past ARG_PROMPT_MAX bytes the prompt goes on stdin, with --no-interactive, as a host's turn
// already sends it; a short one stays an argument.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { tooLongForArg } from '../server/adapters/arg-prompt.mjs';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { fakeCtx, fakeSpawn, fixture } from './kiro-cli-fakes.mjs';
import { tempDir } from './temp-dirs.mjs';

/** Delivers `text` to a fake Kiro, and says what it got: its arguments, how stdin was opened and what came on it. */
async function deliver(text) {
  const root = tempDir('pb-kiro-long-');
  const seen = [];
  const play = fakeSpawn([{ lines: fixture('first'), code: 0 }], seen);
  let stdio = null;
  let stdin = '';
  const spawnImpl = (bin, args, opts) => {
    stdio = opts.stdio;
    const child = play(bin, args, opts);
    if (opts.stdio[0] === 'pipe') {
      const input = new PassThrough();
      input.on('data', (d) => {
        stdin += d;
      });
      Object.assign(child, { stdin: input });
    }
    return child;
  };
  const adapter = new KiroCliAdapter({ workRoot: join(root, 'work'), isolatedHome: join(root, 'home'), spawnImpl: /** @type {any} */ (spawnImpl), env: {} });
  await adapter.deliver({}, { kind: 'user', text }, fakeCtx());
  return { args: seen[0].args, stdio, stdin };
}

test('#362: a short prompt is still Kiro’s last argument, with stdin closed', async () => {
  const { args, stdio, stdin } = await deliver('Remember "heron" <&>.');
  assert.match(args.at(-1), /^Remember "heron" <&>\./);
  assert.equal(args.at(-2), '--');
  assert.equal(stdio[0], 'ignore');
  assert.equal(stdin, '');
});

test('#362: a prompt past the limit goes on stdin with --no-interactive, and isn’t an argument', async () => {
  const text = `start ${'x'.repeat(120_000)} end`;
  const { args, stdio, stdin } = await deliver(text);
  assert.ok(args.includes('--no-interactive'));
  assert.ok(!args.includes('--'));
  assert.ok(
    args.every((a) => a.length < 1000),
    'no argument carries the prompt',
  );
  assert.equal(stdio[0], 'pipe');
  assert.ok(stdin.startsWith(`start ${'x'.repeat(10)}`) && stdin.includes(' end'), 'the whole prompt came on stdin');
});

test('#362: the limit counts bytes, so 40,000 three-byte characters go on stdin too', async () => {
  const { args, stdio } = await deliver('日'.repeat(40_000));
  assert.ok(args.includes('--no-interactive'));
  assert.equal(stdio[0], 'pipe');
});

test('#362: the limit is 100,000 bytes: at it a prompt is still an argument, one byte past it isn’t', () => {
  assert.equal(tooLongForArg('x'.repeat(100_000)), false);
  assert.equal(tooLongForArg('x'.repeat(100_001)), true);
  assert.equal(tooLongForArg(`${'x'.repeat(99_998)}é`), false, 'é is two bytes: 100,000 in all');
  assert.equal(tooLongForArg(`${'x'.repeat(99_999)}é`), true);
});
