// What a reply and an undo share: saving messages, sending events to the window, and making
// sure only one of them runs at a time.
import type { IpcMainInvokeEvent } from 'electron';
import { newId } from '../shared/ids';
import type { AssistantEvent, ChatMessage } from '../shared/types';

/** A new chat message, stamped with an ID and the time. */
export const message = (
  fields: Omit<ChatMessage, 'id' | 'createdAt'>,
): ChatMessage => ({
  id: newId(),
  createdAt: new Date().toISOString(),
  ...fields,
});

/** Sends assistant events to the window that asked, as long as it's still there. */
export const emitter =
  (event: IpcMainInvokeEvent) =>
  (e: AssistantEvent): void => {
    if (!event.sender.isDestroyed()) event.sender.send('assistant:event', e);
  };

let busy: 'reply' | 'undo' | null = null;

/**
 * Claims the assistant for a reply or an undo, so the two never overlap (an undo while a reply
 * is writing files, or two replies appending to the chat). Returns the release function.
 */
export function claim(kind: 'reply' | 'undo'): () => void {
  if (busy === 'reply') {
    throw new Error(
      'The assistant is still replying. Wait for it to finish, or stop it.',
    );
  }
  if (busy === 'undo')
    throw new Error('Changes are being undone. Try again in a moment.');
  busy = kind;
  return () => {
    busy = null;
  };
}
