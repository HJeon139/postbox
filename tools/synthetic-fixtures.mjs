// The fixtures labelled synthetic, and the README’s list of them, which the tree’s privacy test holds to each other
// (tests/process/privacy-tree.test.mjs).

// A fixture labelled synthetic says so on its first line, after a “#” or “//” comment marker, as the delivery spike’s
// baselines do. “SYNTHETIC” later in the line, such as inside a JSON string, isn’t a label.
const SYNTHETIC_LABEL = /^(?:#|\/\/)\s*SYNTHETIC\b/;

/** Whether a fixture’s first line labels it synthetic. @param {string} firstLine */
export function isSyntheticLabel(firstLine) {
  return SYNTHETIC_LABEL.test(firstLine);
}

// A “## ” heading at the start of a line, where the README’s next section begins.
const SECTION = /^## /m;

// A listed fixture: a “- ” line that starts with its path in backticks.
const LISTED_PATH = /^- `([^`]+)`/gm;

/**
 * The paths the fixtures README lists under “Synthetic fixtures”, one per “- `path`” line.
 *
 * @param {string} readme the text of tests/fixtures/README.md
 * @returns {string[]}
 */
export function syntheticFixturePaths(readme) {
  const section = readme.split(SECTION).find((part) => part.startsWith('Synthetic fixtures'));
  if (!section) throw new Error('tests/fixtures/README.md has no “Synthetic fixtures” section');
  return [...section.matchAll(LISTED_PATH)].map(([, path]) => path);
}

/**
 * The synthetic fixtures the README lists that the tree doesn’t hold.
 *
 * @param {string} readme the text of tests/fixtures/README.md
 * @param {(path: string) => boolean} exists whether a path from the repository’s root is in the tree
 * @returns {string[]}
 */
export function missingSyntheticFixtures(readme, exists) {
  return syntheticFixturePaths(readme).filter((path) => !exists(path));
}
