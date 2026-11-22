// The Mermaid diagrams in a reply’s Markdown, which the server’s diagram checks read (shared/diagram-lint.mjs,
// server/diagram-check.mjs). Moved out of shared/diagram-lint.mjs, which had reached its length limit.

/** The closed ```mermaid fences in a Markdown text, in order. */
export function mermaidBlocks(markdown) {
  return [...String(markdown ?? '').matchAll(/^ {0,3}```mermaid[^\n]*\n([\s\S]*?)\n {0,3}```/gm)].map((m, index) => ({ index, src: m[1] }));
}
