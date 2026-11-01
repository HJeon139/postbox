// Private record storage stays inside the Store. HTTP state and SSE frames use these projections; internal
// subscribers, the backlog ring and snapshots retain the original data (designs/508/a1-record-shape.md).
const PRIVATE_COLLECTIONS = ['records', 'dispatches', 'pins', 'receipts', 'receiptCheckpoint'];

/** @param {any} state */
export function publicState(state) {
  const visible = { ...state };
  for (const key of PRIVATE_COLLECTIONS) delete visible[key];
  return visible;
}

/** A cursor preserves the stream position without exposing any record identity or content. @param {any} event */
export function publicEvent(event) {
  return event.type === 'record' || event.type === 'record.close' ? { seq: event.seq, type: 'cursor', data: {} } : event;
}

/** Frame-time projection is shared by live delivery and reconnect backlog. @param {any} event */
export function publicFrame(event) {
  const ev = publicEvent(event);
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}
