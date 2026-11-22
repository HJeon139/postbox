// The model ids in what `agy models` prints, for the model field’s suggestions (#143).

/**
 * The model ids in an `agy models` answer, bounded: one per line, the id, then a tab and its name
 * (“gemini-3.8-flash-high	Gemini 3.8 Flash (High)”). The “Fetching available models...” line and a sign-in
 * error aren’t ids.
 */
export function modelIds(text) {
  const ids = String(text ?? '')
    .split('\n')
    .map((l) => /^([a-z0-9][\w.:-]{0,79})\t/i.exec(l)?.[1])
    .filter((id) => typeof id === 'string');
  return [...new Set(ids)].slice(0, 60);
}
