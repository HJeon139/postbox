// The protocol tests’ cases for asking a host’s harnesses about their sign-in (#1608): `signins` and its answer,
// `signed`, as remote-protocol-cases.mjs gives every other type’s. tests/remote-protocol.test.mjs merges the two.

export const SIGNIN_CASES = {
  'postbox-to-daemon': {
    signins: {
      ok: {},
      bad: [[{ harness: 'claude-code' }, /“harness” isn’t a field of signins/]],
    },
  },
  'daemon-to-postbox': {
    signed: {
      ok: {
        harnesses: [
          { name: 'claude-code', state: 'signed-in', method: 'claude.ai', expiresAt: 1_764_987_734_007 },
          { name: 'kiro-cli', state: 'signed-in', method: 'BuilderId' },
          { name: 'codex', state: 'signed-out' },
        ],
      },
      bad: [
        [{ harnesses: [{ name: 'codex', state: 'maybe' }] }, /signed\.harnesses\[0\]\.state must be one of signed-in, signed-out, unknown/],
        [{ harnesses: [{ name: 'antigravity-cli', state: 'unknown' }] }, /signed\.harnesses\[0\]\.name must be one of/],
        // The method is a short name: an email or a path from the command’s output never crosses in it.
        [{ harnesses: [{ name: 'claude-code', state: 'signed-in', method: 'robin@example.com' }] }, /signed\.harnesses\[0\]\.method must be an ID/],
        [{ harnesses: [{ name: 'claude-code', state: 'signed-in', email: 'robin@example.com' }] }, /“email” isn’t a field of signed\.harnesses\[0\]/],
        [{ harnesses: [{ name: 'claude-code', state: 'signed-in', expiresAt: '2026-12-06T02:42:14.007Z' }] }, /signed\.harnesses\[0\]\.expiresAt must be/],
        [
          {
            harnesses: [
              { name: 'codex', state: 'unknown' },
              { name: 'codex', state: 'unknown' },
            ],
          },
          /twice/,
        ],
        [{ harnesses: [{}, {}, {}, {}] }, /signed\.harnesses has 4 entries; the limit is 3/],
      ],
    },
  },
};
