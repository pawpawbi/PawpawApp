// The provider the assistant talks to, built from the settings. Keys are read here, in the main
// process, and go only into the provider's requests.
import { app } from 'electron';
import type { AssistantProvider } from '../shared/types';
import { anthropic } from './anthropic';
import { PROVIDERS } from './models';
import { ollama } from './ollama';
import { openai } from './openai';
import { readKey } from './settings';
import type { Provider } from './types';

/** The provider, with its key if it needs one. */
export async function providerFor(id: AssistantProvider): Promise<Provider> {
  // Development only: point a provider at a local stand-in server, to try the chat without
  // calling the real API, e.g. PAWPAW_ANTHROPIC_API=http://127.0.0.1:8787/v1.
  const local = app.isPackaged
    ? undefined
    : process.env[`PAWPAW_${id.toUpperCase()}_API`];
  if (id === 'ollama') return ollama(local);
  const key = await readKey(id);
  if (!key) {
    throw new Error(
      `Add your ${PROVIDERS[id].name} API key in Assistant settings first.`,
    );
  }
  return id === 'openai'
    ? openai(key, fetch, local)
    : anthropic(key, fetch, local);
}
