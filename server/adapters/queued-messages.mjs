// A batched turn preserves each queued message’s author, time, attachments and original kind (#374).
export function formatQueuedMessages(messages, pathOf, formatMessage) {
  return `[Postbox] ${messages.length} messages arrived while you were busy. Handle them together in one reply.\n\n${messages
    .map((message, index) => {
      const sender = message.kind === 'user' ? 'the person' : message.from;
      const time = Number.isFinite(message.at) ? new Date(message.at).toISOString() : 'time unavailable';
      return `[Queued message ${index + 1} from ${sender}, ${time}]\n${formatMessage(message, pathOf)}`;
    })
    .join('\n\n')}`;
}
