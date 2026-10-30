// Claude Code records message content as blocks normally, and as one string after compaction (#503).

/** Returns message content in one shape: blocks unchanged, a string as one text block, anything else as none. */
export function contentBlocks(content) {
  if (Array.isArray(content)) return content;
  return typeof content === 'string' ? [{ type: 'text', text: content }] : [];
}
