// The block rules the renderer reads a line by (markdown.mjs), which the review renderer's line grouping
// (review-lines.mjs) and the code-span reader (code-spans.mjs) share. Moved out of markdown.mjs, which imports the
// code-span reader, so that reader can use them without a circular import (#1659).

export const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/;
export const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
export const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
export const QUOTE = /^ {0,3}>\s?(.*)$/;
export const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
// Unambiguous around optional pipes, so a long run of spaces on a non-matching line never backtracks (#1659).
export const TABLE_SEP = /^\s*(?:\|\s*)?:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*(?:\|\s*)?$/;
/** What the renderer reads as escaped after a backslash (markdown-inline.mjs, inline): the pair is text. */
export const ESCAPED = /[\\`*_{}[\]()#+\-.!|$~>@]/;
/** Whether a line closes a fence opened with `marker` (``` or ~~~~): a run of its character, as long or longer (#344). */
export const closesFence = (marker, line) => (/^ {0,3}(`+|~+)\s*$/.exec(line)?.[1] ?? '').startsWith(marker);
