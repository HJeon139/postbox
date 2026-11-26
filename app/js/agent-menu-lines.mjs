// Agent entries in the conversation menu, including phone access to queued messages (#427).

import { factsText } from '/shared/agent-facts.mjs';
import { factsOf, mockMarker } from './agent-facts.mjs';
import { agentQueueMenuItem } from './agent-queue.mjs';
import { stateWordOf } from './ring.mjs';

export function agentMenuLines(sessions, openPersona, queueAnchor) {
  if (!sessions.length) return [];
  return [
    { heading: sessions.length > 1 ? 'Agents' : 'Agent' },
    ...sessions.flatMap((session) =>
      [
        agentQueueMenuItem(session, queueAnchor),
        {
          label: [session.handle, mockMarker(session)],
          icon: 'agent',
          desc: `${factsText(factsOf(session))} · ${stateWordOf(session).toLowerCase()}`,
          kbd: 'Edit',
          run: () => openPersona(session.personaId),
        },
      ].filter(Boolean),
    ),
    'hr',
  ];
}
