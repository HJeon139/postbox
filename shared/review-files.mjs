// The files option renderMarkdown takes for a review block (#780, note as_BkHPLMds v3, §4): each attached file under
// its name and its kept ref, with the item’s route as a same-origin path, so the image loads at either host spelling
// and Cross-Origin-Resource-Policy never blocks the page’s own load. The URL comes only from the item’s ids and the
// stored SHA-256, never from text in the content.

/**
 * @param {string} threadId @param {{ id: string, files?: { name: string, ref: string|null, sha256: string, width: number, height: number }[] }} item
 * @returns {Record<string, { url: string, width: number, height: number }> | undefined}  undefined when it has none
 */
export function reviewFileKeys(threadId, item) {
  const files = item?.files ?? [];
  if (!files.length) return undefined;
  // No prototype, so a file named __proto__ is a key like any other.
  const keys = Object.create(null);
  const at = (f) => ({
    url: `/api/threads/${encodeURIComponent(threadId)}/items/${encodeURIComponent(item.id)}/files/${encodeURIComponent(f.name)}?sha=${encodeURIComponent(f.sha256)}`,
    width: f.width,
    height: f.height,
  });
  // Refs first, then names: when one file’s ref is another’s name, the name wins.
  for (const f of files) if (f.ref) keys[f.ref] = at(f);
  for (const f of files) keys[f.name] = at(f);
  return keys;
}
