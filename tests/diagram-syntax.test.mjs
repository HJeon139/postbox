// #731: a diagram Mermaid can’t parse reaches its agent from the server, in the turn’s lint turn, without any page
// drawing it: with lazy diagram frames (#701), the page’s report waited until the person scrolled to the diagram. The
// agent still hears about each diagram once: the page’s report of the same error later goes nowhere. The broken
// sources are ones Mermaid refuses as the page draws them (Mermaid’s own messages, from the bundled 11.x).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './blocks-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fence = (src) => `\`\`\`mermaid\n${src}\n\`\`\``;
/** An arrow with no target. */
const BROKEN = 'flowchart TD\n  A[Plan] --> B[Build]\n  B -->';
/** Too wide to read in the column, and broken too. */
const WIDE = `flowchart LR\n${Array.from({ length: 14 }, (_, i) => `N${i}[Step number ${i}]`).join(' --> ')} -->`;

/** The lint turns the agent got, waiting for the parser’s worker to start the first time. */
async function lints(adapter, want = 1) {
  for (let i = 0; i < 400 && adapter.calls.filter((c) => c.message.kind === 'lint').length < want; i++) await sleep(25);
  return adapter.calls.filter((c) => c.message.kind === 'lint').map((c) => c.message);
}

test('#731 a reply with a diagram Mermaid can’t parse gets its agent Mermaid’s message, with no page drawing it', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => c.text(`The plan:\n\n${fence(BROKEN)}`));
  rt.sendMessage(t.id, { text: 'draw the plan' });
  await settle(rt);
  const [lint] = await lints(adapter);
  assert.ok(lint, 'a lint turn came');
  const [problem] = lint.problems;
  assert.equal(problem.code, 'diagram-error');
  assert.match(problem.message, /Mermaid said \(line \d+\): “Parse error on line \d+:/);
  assert.equal(problem.scope.index, 0);
  // The page draws it later and reports the same error: the agent has heard, so it goes nowhere.
  const reply = store.items(t.id).find((i) => i.kind === 'agent' && !i.lintReply);
  const late = rt.diagramCheck(t.id, reply.id, { src: BROKEN, error: { message: 'Parse error on line 3:', line: 3 } });
  assert.equal(late.sent, false, 'the page’s report of the same diagram');
});

test('#731 a diagram the estimate flags as too small gets its syntax error in the same lint turn', async () => {
  const { rt, t, adapter } = setup();
  // As Postbox waits for late reports before a lint turn goes (lint-delivery.mjs, LINT_SETTLE_MS), so the parse joins it.
  rt.checks.config.lintSettleMs = 1500;
  adapter.next.push(async (c) => c.text(fence(WIDE)));
  rt.sendMessage(t.id, { text: 'draw the steps' });
  await settle(rt);
  // Wait for both problems: the parse may land a moment after the estimate.
  let codes = [];
  for (let i = 0; i < 400 && !codes.includes('diagram-error'); i++) {
    codes = (await lints(adapter)).flatMap((l) => l.problems.map((p) => p.code));
    await sleep(25);
  }
  assert.deepEqual(codes.sort(), ['diagram-error', 'text-too-small']);
  assert.equal((await lints(adapter)).length, 1, 'one lint turn');
});

test('#731 a diagram that parses gets no lint turn', async () => {
  const { rt, t, adapter } = setup();
  adapter.next.push(async (c) => c.text(fence('flowchart TD\n  A[Plan] --> B[Build]')));
  rt.sendMessage(t.id, { text: 'draw the plan' });
  await settle(rt);
  // The parser answers within its own limit; give it time to, and to land a lint turn if it wrongly would.
  await sleep(1500);
  assert.deepEqual(await lints(adapter, 0), []);
});
