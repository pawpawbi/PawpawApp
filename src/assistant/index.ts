// Main-process side of the assistant: the IPC handlers. The work is in reply.ts (a reply),
// undo.ts (undoing changes), settings.ts (settings and keys) and providers.ts (the model).
import { ipcMain } from 'electron';
import type {
  ApprovalAnswer,
  AssistantPermissions,
  AssistantProvider,
} from '../shared/types';
import { providerFor } from './providers';
import { answer, reply, stop } from './reply';
import {
  getSettings,
  removeKey,
  saveSettings,
  setKey,
  setPermissions,
} from './settings';
import { journal, undo } from './undo';

export function registerAssistantHandlers() {
  ipcMain.handle('assistant:get-settings', () => getSettings());
  ipcMain.handle(
    'assistant:save-settings',
    (_event, provider: AssistantProvider, model: string) =>
      saveSettings(provider, model),
  );
  ipcMain.handle(
    'assistant:set-permissions',
    (_event, permissions: AssistantPermissions) => setPermissions(permissions),
  );
  ipcMain.handle(
    'assistant:set-key',
    (_event, provider: AssistantProvider, key: string) => setKey(provider, key),
  );
  ipcMain.handle(
    'assistant:remove-key',
    (_event, provider: AssistantProvider) => removeKey(provider),
  );
  ipcMain.handle(
    'assistant:list-models',
    async (_event, provider: AssistantProvider) =>
      (await providerFor(provider)).listModels(AbortSignal.timeout(20_000)),
  );
  ipcMain.handle('assistant:send', (event, text: string) => reply(event, text));
  ipcMain.handle('assistant:retry', (event) => reply(event, null));
  ipcMain.handle('assistant:stop', () => stop());
  ipcMain.handle(
    'assistant:answer',
    (_event, id: string, choice: ApprovalAnswer) => answer(id, choice),
  );
  ipcMain.handle('assistant:list-changes', () => journal().list());
  ipcMain.handle('assistant:undo', (event, id: string, force?: boolean) =>
    undo(event, id, force === true),
  );
}
