// Header-only readers; these do not consult transcript items or retain collection references across an await.
const ordered = (a, b) => a.at - b.at || a.id.localeCompare(b.id);

export function askHeaders(state, conversationId = null) {
  return Object.values(state.records ?? {})
    .filter((r) => r.kind === 'ask' && (!conversationId || r.conversationId === conversationId))
    .map(({ id, from, conversationId, threadId, sourceId, askKind, title, summary, at }) => ({
      id,
      from,
      conversationId,
      threadId,
      sourceId,
      askKind,
      title,
      summary,
      at,
    }))
    .sort(ordered);
}

export function deliveryHeaders(state, to) {
  return Object.values(state.records ?? {})
    .filter((r) => r.kind === 'delivery' && r.to.persona === to.persona && r.to.session === to.session)
    .map(({ id, conversationId, threadId, sourceId, state, rev, at }) => ({ id, conversationId, threadId, sourceId, state, rev, at }))
    .sort(ordered);
}

/** Only accepted lifecycle events enter this pure projection. Persistence is A1b's producer prerequisite. */
export function receiptRows(events) {
  const rows = new Map();
  for (const e of events) {
    if (e.type !== 'record.close' && !(e.type === 'record' && e.data.operation === 'requeue' && e.data.final === 'delivered')) continue;
    const d = e.data;
    const id = e.type === 'record' ? d.record.id : d.id;
    const key = JSON.stringify([id, d.previousVersion]);
    if (!rows.has(key))
      rows.set(key, {
        id,
        version: d.previousVersion,
        final: d.final,
        at: d.at,
        ...(d.reason ? { reason: d.reason } : {}),
        ...(d.attemptIdentity ? { attemptIdentity: structuredClone(d.attemptIdentity) } : {}),
      });
  }
  return [...rows.values()];
}

/** Failure and denial remain session-owned status, not fabricated ask records. Their `from` is a session id, as an ask record's `from` is (a1-record-shape.md, Ask). */
export function attentionHeaders(state, sessions = Object.values(state.sessions ?? {})) {
  const statuses = sessions
    .filter((se) => ['failed', 'denial'].includes(se.needs?.kind))
    .map((se) => ({
      id: `status:${se.id}`,
      kind: 'status',
      from: se.id,
      threadId: se.needs.threadId ?? se.threadId,
      askKind: se.needs.kind,
      at: se.updatedAt ?? 0,
    }));
  return [...askHeaders(state), ...statuses].sort(ordered);
}

/** Replay reads only immutable pinned content; a caller cannot mutate the retained manifest. */
export function dispatchManifest(state, dispatchId) {
  if (!Object.hasOwn(state.dispatches ?? {}, dispatchId)) return null;
  const manifest = state.dispatches[dispatchId];
  if (manifest.renderVersion !== 1)
    throw Object.assign(new Error('The dispatch renderer is unavailable; reconcile this dispatch before replay.'), { code: 'ERECORD' });
  return structuredClone(manifest);
}
