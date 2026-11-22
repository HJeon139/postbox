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
  s1 --> s2: 2. passes
  state "3. Ship" as s3`;
const STATE_LABELS = ['1. Build', '- Lint', '2. passes', '3. Ship'];
// A class relation’s label follows a colon too; a member’s, after a bare class name, keeps its visibility mark.
const CLASSES = `classDiagram
  class Build["1. Build"]
  Build : +int count
  Build : - String name
  Build --> Test : 1. uses`;
// A class diagram’s arrows and annotations are syntax, not label starts: each must still draw.
const CLASS_SYNTAX = `classDiagram
  Shape --|> Base : Inheritance
  Circle ..|> Shape
  Car --* Wheel
  Fleet "1" --* "many" Car
  <<interface>> Shape
  Wheel : - decrement() --`;
// Notes: a class diagram’s, after “note” or “note for A”, and a state diagram’s over lines, to “end note”.
const CLASS_NOTES = `classDiagram
  class Build
  note for Build "1. note"
  note "- general"
  note for Build"2. tight"`;
const STATE_NOTE = `stateDiagram-v2
  s1 --> s2
  note right of s1
    1. first
    - second
  end note
  Note left of s2
    3. capital
  End note`;
// A directive over lines before the header (“%%{init: …}%%”) doesn’t hide that it’s a class diagram: its arrow draws.
const CLASS_DIRECTIVE = `%%{init: {
  "theme": "base"
}}%%
classDiagram
  Shape --|> Base : Inheritance
  Build --> Test : 1. uses`;
// Members that read like a state note in a class diagram stay members: its “- String field” is private. A member named
// “stateDiagram” doesn’t make it one: the type is the diagram’s first word.
const CLASS_NOTE_LIKE = `classDiagram
  class Build {
    stateDiagram
    note right of s1
    - String field
    end note
  }`;
// Slanted shapes open with “[/” or “[\\”.
const SLANTED = `flowchart TD
  A[/1. Plan/] --> B[\\- Check\\]
  B --> C[/---/]`;
// The other blocks Mermaid can’t draw at a label’s start: a heading, a quote and a rule.
const BLOCKS = `flowchart TD
  A[# of users] --> B["> quoted"]
  B --> C[---]`;
// A Markdown string can run over lines, each of which can start like a list item, its first one included.
const MARKDOWN_LINES = `flowchart TD
  A["\`
1. Build
- Lint
then ship\`"] --> B[Done]`;
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
  ['a Markdown string’s', MARKDOWN_LINES, ['1. Build', '- Lint', 'then ship']],
  // A member’s “-” marks it private, so it stays Mermaid’s to read: no joiner goes before it.
  ['a class diagram’s', CLASSES, ['1. Build', '+int count', '- String name', '1. uses'], ['- String name']],
  ['a heading’s, a quote’s and a rule’s', BLOCKS, ['# of users', '> quoted', '---']],
  ['a class diagram’s notes', CLASS_NOTES, ['1. note', '- general', '2. tight']],
  ['a state diagram’s note', STATE_NOTE, ['1. first', '- second', '3. capital']],
  ['a class diagram’s, after a directive over lines,', CLASS_DIRECTIVE, ['Inheritance', '1. uses']],
  ['a class diagram’s note-like members, around its', CLASS_NOTE_LIKE, ['String field'], ['- String field']],
  ['a slanted shape’s', SLANTED, ['1. Plan', '- Check', '---']],
  ['a class diagram’s arrows and annotations, around its', CLASS_SYNTAX, ['Inheritance', 'interface', '- decrement()'], ['- decrement()']],
]))
  test(`#684 ${kind} labels that start like a block show as written`, async ({ page }) => {
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
