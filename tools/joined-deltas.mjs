// A JSONL recording’s streams with their deltas joined, for the privacy checker (tools/privacy-check.mjs), which checks
// each joined stream again so a value split across deltas is whole (#742).

/** The delta fields a recorded stream splits its text across: tool input, reply text and thinking. */
const DELTA_FIELDS = ['partial_json', 'text', 'thinking'];

/** The text a delta carries, from the first field that holds a string, or null. @param {Record<string, unknown>} delta */
function deltaText(delta) {
  const field = DELTA_FIELDS.find((name) => typeof delta[name] === 'string');
  return field === undefined ? null : delta[field];
}

/**
 * Each stream of a JSONL recording, its deltas joined in order: a value split across deltas, such as a home path cut
 * in three, is whole again. A stream is one message’s content block of one delta type. One pass over the lines, with a
 * Map from each stream to its parts, so the work is linear in the file’s size.
 *
 * @param {string} content
 * @returns {{ firstLine: number, text: string }[]}
 */
export function joinedDeltas(content) {
  const streams = new Map();
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const event = parsedEvent(lines[index]);
    const delta = event?.delta;
    if (!delta || typeof delta !== 'object') continue;
    const text = deltaText(delta);
    if (text === null) continue;
    const key = `${event.messageId}\u0000${event.index}\u0000${delta.type}`;
    const stream = streams.get(key) ?? { firstLine: index + 1, parts: [] };
    stream.parts.push(text);
    streams.set(key, stream);
  }
  return [...streams.values()].map(({ firstLine, parts }) => ({ firstLine, text: parts.join('') }));
}

/**
 * A line’s stream event, with the message it belongs to, or null when the line isn’t one. Claude Code wraps the event
 * as { event: { index, delta }, api_message_id }; a bare event has { index, delta } at the top.
 *
 * @param {string} line
 */
function parsedEvent(line) {
  if (!line.includes('delta')) return null;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object') return null;
  const event = record.event && typeof record.event === 'object' ? record.event : record;
  const messageId = record.api_message_id ?? record.session_id ?? '';
  return { delta: event.delta, index: event.index ?? '', messageId };
}
