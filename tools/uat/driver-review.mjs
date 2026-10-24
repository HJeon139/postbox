// The UAT driver’s answer to a review block, as a person gives it. Moved out of tools/uat/driver.mjs; the driver’s own
// helpers it reads come in as its first parameter: ev, clickAt, byText and typeInto.

import { ITEM, J } from './selectors.mjs';

/**
 * Answers a review block as a person does: a draft comment on each line, in Lines (its gutter button, the box, “Add
 * draft comment”), then the verdict, then Submit review. Request changes and Comment need a comment to say what.
 * @param {string} key  @param {{ verdict?: string, comments?: { line: string, text: string }[] }} review
 */
export async function review({ ev, clickAt, byText, typeInto }, key, { verdict = 'comment', comments = [] } = {}) {
  const names = { approve: 'Approve', request_changes: 'Request changes', comment: 'Comment' };
  if (!names[verdict]) throw new Error(`A review’s verdict is approve, request_changes or comment, not “${verdict}”.`);
  if (verdict !== 'approve' && !comments.length) throw new Error('Request changes and Comment need at least one comment on a line, saying what to change.');
  if (!(await ev(`!!${ITEM(key)}?.querySelector('[aria-label="Verdict"]')`))) throw new Error('That item isn’t a review waiting for an answer.');
  // A Markdown draft opens in Preview (#179); its lines take their comments in Lines.
  const view = `${ITEM(key)}?.querySelector('[aria-label="View"]')`;
  if (comments.length && (await ev(`!!${view}`))) await clickAt(byText(view, '[role=radio]', 'Lines'), '“Lines”');
  for (const { line, text } of comments) {
    const n = String(line)
      .replace(/^line\s*/i, '')
      .trim();
    await clickAt(`${ITEM(key)}?.querySelector(${J(`button[aria-label="Comment on line ${n}"]`)})`, `line ${n}’s comment button`);
    const box = `${ITEM(key)}?.querySelector(${J(`textarea[aria-label="Comment on line ${n}"]`)})`;
    await typeInto(box, String(text), `the comment box on line ${n}`);
    await clickAt(byText(ITEM(key), 'button', 'Add draft comment'), '“Add draft comment”');
  }
  await clickAt(byText(`${ITEM(key)}?.querySelector('[aria-label="Verdict"]')`, '[role=radio]', names[verdict]), `the verdict “${names[verdict]}”`);
  await clickAt(byText(ITEM(key), 'button', 'Submit review'), '“Submit review”');
}
