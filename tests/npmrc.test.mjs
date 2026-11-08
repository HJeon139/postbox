// The repository's own npm settings (.npmrc). onnxruntime-node, which kokoro-js brings for narration, downloads a
// CUDA build of ONNX Runtime from GitHub's releases in its postinstall, unless told to skip it. When GitHub answered
// 504 on the build host, the script failed, npm dropped kokoro-js's whole optional subtree, @types/node and
// @huggingface/transformers with it, and `npm ci` still exited 0. `npm run check` then failed at typecheck on every
// branch. Narration runs on the CPU (server/narration/worker.mjs), so the CUDA build is never needed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** The settings in a .npmrc, as npm reads them: key=value lines, with # and ; comments. @param {string} text */
const settings = (text) =>
  Object.fromEntries(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith(';'))
      .map((line) => line.split('=').map((part) => part.trim())),
  );

test('installs skip onnxruntime-node’s CUDA download, so a GitHub outage can’t drop narration’s packages', () => {
  const npmrc = readFileSync(new URL('../.npmrc', import.meta.url), 'utf8');
  assert.equal(settings(npmrc)['onnxruntime-node-install-cuda'], 'skip');
});
