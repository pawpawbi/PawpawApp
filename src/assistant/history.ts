// Saved chat messages (chat/messages.jsonl) as the conversation sent to the model.
// No Electron imports, so it's tested with plain Node.
import type { ChatMessage } from '../shared/types';
import type { Turn } from './types';

/** How much of the conversation is sent with each request. */
export const HISTORY_MESSAGES = 80;

/**
 * Stands in for the reply to a message that got none (the user pressed Stop before anything was
 * written, or it failed), so the model doesn't answer that message along with the next one.
 */
export const NO_REPLY =
  '[No reply: the user stopped it or it failed. Answer only their next message.]';

/**
 * The most recent messages as the model's conversation, starting at a user message (so a tool
 * result is never sent without the call it answers).
 */
export function toTurns(messages: ChatMessage[]): Turn[] {
  const recent = messages.slice(-HISTORY_MESSAGES);
  const start = recent.findIndex((m) => m.role === 'user');
  const kept = start === -1 ? [] : recent.slice(start);
  return kept.flatMap((m, i): Turn[] => {
    if (m.role === 'user') {
      // A note about something the user did (e.g. undoing) isn't a question to answer.
      const unanswered = !m.event && kept[i + 1]?.role === 'user';
      return [
        { role: 'user', text: m.text },
        ...(unanswered ? [{ role: 'assistant' as const, text: NO_REPLY }] : []),
      ];
    }
    if (m.role === 'assistant') {
      return [
        {
          role: 'assistant',
          text: m.text,
          ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
        },
      ];
    }
    if (m.toolCallId) {
      return [
        {
          role: 'tool',
          toolCallId: m.toolCallId,
          name: m.toolName ?? '',
          content: m.text,
          ...(m.isError ? { isError: true } : {}),
        },
      ];
    }
    return [];
  });
}
