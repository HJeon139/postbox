// The words for a form’s number field’s range, shared by the hint the page shows under the field and the error a
// submit gets, so the two can’t drift apart (#822).

const fmtNum = (n) => Number(n).toLocaleString('en-US');

/** The range’s words, and what comes before them in the error. */
function words(f) {
  const min = typeof f.min === 'number' ? fmtNum(f.min) : null;
  const max = typeof f.max === 'number' ? fmtNum(f.max) : null;
  if (min !== null && max !== null) return { lead: '', phrase: `from ${min} to ${max}` };
  if (min !== null) return { lead: 'of ', phrase: `at least ${min}` };
  if (max !== null) return { lead: '', phrase: `no more than ${max}` };
  return { lead: '', phrase: '' };
}

/**
 * A number field’s range in words: the hint under the field, as a sentence (“From 500 to 10,000.”, “At least 500.”,
 * “No more than 10,000.”, or '' with neither a min nor a max), and the error a value outside it gets, built from the
 * same words.
 * @param {{ min?: number, max?: number }} f
 * @returns {{ hint: string, error: string }}
 */
export function numberRange(f) {
  const { lead, phrase } = words(f);
  if (!phrase) return { hint: '', error: 'Enter a number.' };
  return { hint: `${phrase[0].toUpperCase()}${phrase.slice(1)}.`, error: `Enter a number ${lead}${phrase}.` };
}
