import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessage } from '../server/adapters/guide.mjs';
import { diagramProblems, lintMessage } from '../server/checks.mjs';
import { lintDiagram, lintDiagrams, mermaidBlocks, parseFlowchart, parseSequence } from '../shared/diagram-lint.mjs';

// The diagram a real agent drew for “how a query flows through BM25”: seven steps side by side, long labels.
// In the browser its text came out at about 6 px.
const WIDE = `flowchart LR
  Q[Query text] --> T[Tokenize and lowercase]
  T --> L[Look up each term in the inverted index]
  L --> S[Score each passage: IDF × term frequency, adjusted for passage length]
  S --> R[Sort by score]
  R --> K[Keep the top k]
  K --> O[Passages with book, chapter and score]`;

const LOOP = `flowchart LR
  Q[Question] --> T[Thought]
  T --> A[Action]
  A --> O[Observation]
  O -->|feeds the next thought| T
  T -->|when done| Ans[Answer]`;

test('finds closed mermaid fences only', () => {
  const md = 'Text\n\n```mermaid\ngraph LR\nA-->B\n```\n\n```js\nx\n```\n\n```mermaid\ngraph TD\nC-->D\n```\n\n```mermaid\ngraph LR\nE-->';
  assert.deepEqual(
    mermaidBlocks(md).map((b) => b.src),
    ['graph LR\nA-->B', 'graph TD\nC-->D'],
  );
});

test('parses flowchart nodes, labels, chains, & groups and edge labels', () => {
  const g = parseFlowchart('flowchart LR\n  A[Start] -- reads --> B((Parse))\n  B -->|ok| C{Index?} & D[Skip]\n  %% a comment\n  classDef x fill:#fff');
  assert.equal(g.dir, 'LR');
  assert.deepEqual(
    [...g.nodes],
    [
      ['A', 'Start'],
      ['B', 'Parse'],
      ['C', 'Index?'],
      ['D', 'Skip'],
    ],
  );
  assert.deepEqual(
    g.edges.map((e) => `${e.from}>${e.to}:${e.label}`),
    ['A>B:reads', 'B>C:ok', 'B>D:ok'],
  );
});

test('a long chain side by side with long labels is too small to read, and the message says how to fix it', () => {
  const r = lintDiagram(WIDE);
  assert.ok(r.textPx < 8, `estimated ${r.textPx} px`);
  assert.equal(r.problems[0].code, 'text-too-small');
  assert.match(r.problems[0].message, /7 steps side by side; draw it top to bottom/);
  assert.match(r.problems[0].message, /longest label has 69 characters/);
});

test('ordinary diagrams pass, loops included', () => {
  for (const src of [LOOP, 'graph LR\nA-->B-->C', 'flowchart TD\nA-->B\nA-->C\nB-->D\nC-->D', 'sequenceDiagram\nYou->>Postbox: hi\nPostbox->>Agent: hi']) {
    assert.deepEqual(lintDiagram(src).problems, [], src);
  }
});

test('one very long row of boxes shrinks the text, and the message points at the row', () => {
  const r = lintDiagram('flowchart TD\nA[Root] --> B1[one] & B2[two] & B3[three] & B4[four] & B5[five] & B6[six] & B7[seven] & B8[eight] & B9[nine]');
  assert.equal(r.problems[0].code, 'text-too-small');
  assert.match(r.problems[0].message, /One row has 9 boxes side by side/);
});

// Text sizes measured in Chrome at the conversation’s width (728 px), against the estimate. The layout constants
// in shared/diagram-lint.mjs were fitted to these; the estimate should stay within about a pixel of them.
const MEASURED = [
  [WIDE, 5.1],
  ['flowchart LR\n  A[Read] --> B[Parse] --> C[Index] --> D[Rank] --> E[Show]', 13],
  ['flowchart LR\n  A[Read the files] --> B[Parse chapters] --> C[Split passages] --> D[Tokenize text] --> E[Build index] --> F[Write manifest]', 7.5],
  ['flowchart TD\nA[Root] --> B1[one] & B2[two] & B3[three] & B4[four] & B5[five] & B6[six] & B7[seven] & B8[eight] & B9[nine]', 7.4],
  ['flowchart TD\nA[Corpus] --> B1[Moby-Dick] & B2[Middlemarch] & B3[Emma] & B4[Walden] & B5[Persuasion] & B6[Dubliners]', 8.9],
  [
    'sequenceDiagram\nparticipant You\nparticipant Postbox\nparticipant Agent\nparticipant MCP\nparticipant Tool\nparticipant Store\nYou->>Postbox: message\nPostbox->>Agent: deliver',
    7.3,
  ],
  ['sequenceDiagram\nYou->>Postbox: message\nPostbox->>Agent: deliver with context\nAgent->>MCP: show_block\nMCP-->>Postbox: block', 10.6],
];

test('the estimate matches text sizes measured in the browser, within about a pixel', () => {
  for (const [src, measured] of MEASURED) {
    const { textPx } = lintDiagram(src);
    assert.ok(Math.abs(textPx - measured) <= 1, `${src.split('\n')[0]}…: estimated ${textPx}, measured ${measured}`);
    assert.equal(textPx < 10, measured < 10, 'it flags exactly the ones the browser would');
  }
});

test('too many boxes is flagged even when they fit', () => {
  const lines = Array.from({ length: 35 }, (_, i) => `  N${i}[n${i}] --> N${i + 1}[n${i + 1}]`);
  const r = lintDiagram(`flowchart TD\n${lines.join('\n')}`);
  assert.ok(r.problems.some((p) => p.code === 'too-many-parts'));
});

test('sequence diagrams: participants side by side shrink the text', () => {
  const six =
    'sequenceDiagram\nparticipant You\nparticipant Postbox\nparticipant Agent\nparticipant MCP\nparticipant Tool\nparticipant Store\nYou->>Postbox: go';
  assert.equal(parseSequence(six).participants.size, 6);
  assert.equal(lintDiagram(six).problems[0].code, 'text-too-small');
  const long = `sequenceDiagram\n${Array.from({ length: 45 }, () => 'A->>B: ping').join('\n')}`;
  assert.ok(lintDiagram(long).problems.some((p) => p.code === 'too-long'));
});

test('a reply’s illegible diagrams come back numbered, and the agent is told what to do', () => {
  const md = `Before\n\n\`\`\`mermaid\n${LOOP}\n\`\`\`\n\nAfter\n\n\`\`\`mermaid\n${WIDE}\n\`\`\``;
  const found = lintDiagrams(md);
  assert.deepEqual(
    found.map((d) => d.index),
    [1],
  );
  const text = formatMessage(lintMessage(diagramProblems(found)));
  assert.match(text, /^\[Postbox\] Diagram 2 in your reply can’t be read \(it starts “flowchart LR”\):/);
  assert.match(text, /Reply with a corrected version/);
});
