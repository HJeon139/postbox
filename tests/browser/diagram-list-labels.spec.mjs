// #684: Mermaid reads a node label as Markdown, and one that starts like a list item (“1. Build”, “- Lint”) became a
// list, which its labels can’t show: the node read “Unsupported markdown: list” in place of the step. Agents number
// their steps often. The diagram’s frame now escapes such a start before Mermaid draws it, so the label shows as written,
// in node shapes, quoted labels, Markdown strings and edge labels alike, and in state and class diagrams. The first two
// labels are the ones the UAT run drew (the issue’s source). A sequence diagram’s arrow into “+ B” or “- A” activates B or
// ends A’s activation, and is left as it is.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const SOURCE = `flowchart TD
  A[1. Build: compile and package] --> B[2. Test: run the suite]
  B -->|1. passes| C["3) Ship"]
  B --> D{- Lint}
  D --> E["* Review"]
  E --> F[+ Merge]
  F --> G[[10. Release]]
  G -- 4. tag it --> H["\`5. Announce\`"]`;
// A state diagram’s labels follow a colon, a class diagram’s a quote; both go through the same Markdown.
const STATES = `stateDiagram-v2
  s1: 1. Build
  s2: - Lint
  s1 --> s2: 2. passes`;
const STATE_LABELS = ['1. Build', '- Lint', '2. passes'];
const CLASSES = `classDiagram
  class Build["1. Build"]
  Build : +int count
  Build : - String name`;
// A space after the arrow’s “+” or “-” is allowed: a joiner there would start a stray participant named “- A”.
const SEQUENCE = `sequenceDiagram
  A->>+ B: hi
  B-->>- A: done`;
const LABELS = [
  '1. Build: compile and package',
  '2. Test: run the suite',
  '1. passes',
  '3) Ship',
  '- Lint',
  '* Review',
  '+ Merge',
  '10. Release',
  '4. tag it',
  '5. Announce',
];

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('diagram-list-labels');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** Posts a reply with one Mermaid diagram and returns its drawn text, spaces as spaces, once it has drawn. */
async function drawn(page, source) {
  const { rt } = app;
  const t = rt.createThread({
    projectId: Object.values(rt.store.state.projects)[0].id,
    title: 'Numbered steps',
    personaIds: [arrange.persona(rt, 'researcher').id],
  });
  const se = arrange.agentIn(rt, t.id);
  const text = `The release:\n\n\`\`\`mermaid\n${source}\n\`\`\`\n`;
  arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const iframe = page.locator(`.transcript[data-thread="${t.id}"] figure.diagram iframe`);
  await expect(iframe, 'the diagram draws').toHaveAttribute('data-sized', '1', { timeout: 20_000 });
  const out = page.frameLocator(`.transcript[data-thread="${t.id}"] figure.diagram iframe`).locator('#out');
  await expect(out.locator('.err'), 'Mermaid drew it, with no error').toHaveCount(0);
  await expect(out.locator('svg'), 'Mermaid drew it').toBeAttached();
  // Mermaid sets a label’s spaces as non-breaking; read them as spaces.
  return ((await out.locator('svg').textContent()) ?? '').replace(/\u00a0/g, ' ');
}

for (const [kind, source, labels, plain = []] of /** @type {[string, string, string[], string[]?][]} */ ([
  ['a flowchart’s node and edge', SOURCE, LABELS],
  ['a state diagram’s', STATES, STATE_LABELS],
  // A member’s “-” marks it private, so it stays Mermaid’s to read: no joiner goes before it.
  ['a class diagram’s', CLASSES, ['1. Build', '+int count', '- String name'], ['- String name']],
]))
  test(`#684 ${kind} labels that start like a list item show as written`, async ({ page }) => {
    const shown = await drawn(page, source);
    expect(shown, 'no label says “Unsupported markdown”').not.toContain('Unsupported markdown');
    for (const label of labels) expect(shown, `the label “${label}”`).toContain(label);
    for (const mark of plain) expect(shown, `“${mark}” left as Mermaid reads it`).not.toContain(`\u2060${mark}`);
  });

test('#684 a sequence diagram’s activations after an arrow draw as before', async ({ page }) => {
  const shown = await drawn(page, SEQUENCE);
  for (const words of ['hi', 'done']) expect(shown, `the message “${words}”`).toContain(words);
  expect(shown, 'no participant named after the activation mark').not.toMatch(/[-+] [AB]/);
});
