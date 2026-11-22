// critic’s review of #1642: the server’s diagram checks read a reply’s Mermaid diagrams as the renderer draws them,
// from the renderer’s own output (shared/markdown.mjs), with the source the page reads from each figure. Before, they matched ```mermaid by a pattern of their own, so
// a ~~~mermaid diagram the page draws went unchecked, and a ```mermaid-example the page shows as code was checked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../shared/markdown.mjs';
import { mermaidBlocks } from '../shared/mermaid-blocks.mjs';

const CASES = [
  ['a ``` fence', '```mermaid\ngraph LR\nA-->B\n```', ['graph LR\nA-->B']],
  ['a ~~~ fence', '~~~mermaid\ngraph LR\nA-->B\n~~~', ['graph LR\nA-->B']],
  ['its language in any case', '```Mermaid\ngraph LR\nA-->B\n```', ['graph LR\nA-->B']],
  ['a longer closing marker', '```mermaid\ngraph LR\nA-->B\n`````', ['graph LR\nA-->B']],
  ['mermaid-example, which is code', '```mermaid-example\ngraph LR\nA-->B\n```', []],
  ['a Mermaid fence inside a longer fence, which is code', '````md\n```mermaid\ngraph LR\nA-->B\n```\n````', []],
  ['an unclosed fence', '```mermaid\ngraph LR\nA-->B', []],
  // The pre-review of #1642’s fix: each of these the renderer draws, or doesn’t, as written.
  ['a fence in a quote', '> ```mermaid\n> graph LR\n> A-->B\n> ```', ['graph LR\nA-->B']],
  // The item’s body keeps the indent past the list’s own, as the page’s figure has it.
  ['a fence in a list item, indented four spaces', '- Step\n\n    ```mermaid\n    graph LR\n    A-->B\n    ```', ['  graph LR\n  A-->B']],
  ['a fence in a list item, indented three spaces', '1. Step\n   ```mermaid\n   graph LR\n   A-->B\n   ```', [' graph LR\n A-->B']],
  ['Windows line endings', '```mermaid\r\ngraph LR\r\nA-->B\r\n```', ['graph LR\nA-->B']],
  ['a fence inside display math, which is math', '$$\n```mermaid\ngraph LR\nA-->B\n```\n$$', []],
  ['its source with characters the page escapes', '```mermaid\ngraph LR\nA["a & <b>"] --> B\n```', ['graph LR\nA["a & <b>"] --> B']],
  ['two, in order', 'One:\n\n```mermaid\ngraph LR\nA-->B\n```\n\nTwo:\n\n~~~mermaid\ngraph TD\nC-->D\n~~~', ['graph LR\nA-->B', 'graph TD\nC-->D']],
];

for (const [name, markdown, sources] of CASES)
  test(`the server reads ${name} as the renderer does`, () => {
    assert.deepEqual(
      mermaidBlocks(markdown).map((b) => b.src),
      sources,
    );
    assert.deepEqual(
      mermaidBlocks(markdown).map((b) => b.index),
      sources.map((_s, i) => i),
    );
    // The renderer agrees: one diagram figure for each.
    assert.equal((renderMarkdown(markdown).match(/class="md-mermaid"/g) ?? []).length, sources.length, 'the page draws as many');
  });
