// critic’s review of #1642 (#731): the lint turn waited only its 1.5 s settle for the server’s Mermaid parse, so a
// syntax error found later, though within the parser’s own time limit, was lost when the estimate had flagged the same
// diagram. The parse now holds the lint turn, as an app still being checked does. The parser here is a stand-in that
// answers after 1.8 s (tests/fixtures/diagram-parse/slow-worker.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useParser } from '../server/diagram-parse.mjs';
import { settle, setup } from './blocks-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Too wide to read in the column, so the estimate flags it at once. */
const WIDE = `flowchart LR\n${Array.from({ length: 14 }, (_, i) => `N${i}[Step number ${i}]`).join(' --> ')} -->`;

test('#731 a syntax error the parser finds after the lint turn’s settle still joins it', async () => {
  useParser({ url: new URL('./fixtures/diagram-parse/slow-worker.mjs', import.meta.url), ms: 5000 });
  const { rt, t, adapter } = setup();
  // As Postbox waits for late reports before a lint turn goes (lint-delivery.mjs, LINT_SETTLE_MS).
  rt.checks.config.lintSettleMs = 1500;
  adapter.next.push(async (c) => c.text(`\`\`\`mermaid\n${WIDE}\n\`\`\``));
  rt.sendMessage(t.id, { text: 'draw the steps' });
  await settle(rt);
  const lints = () => adapter.calls.filter((c) => c.message.kind === 'lint').map((c) => c.message);
  for (let i = 0; i < 400 && !lints().length; i++) await sleep(25);
  assert.equal(lints().length, 1, 'one lint turn');
  assert.deepEqual(
    lints()[0]
      .problems.map((p) => p.code)
      .sort(),
    ['diagram-error', 'text-too-small'],
  );
});
