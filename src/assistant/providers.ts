// The provider the assistant talks to, built from the settings. Keys and the PawpawBI sign-in are
// read here, in the main process, and go only into the provider's requests.
import { app } from 'electron';
import { forgetIfSignedOut, signedInToken } from '../account';
import type { AssistantProvider } from '../shared/types';
import { anthropic } from './anthropic';
import { PROVIDERS } from './models';
import { openai } from './openai';
import { pawpaw } from './pawpaw';
import { readKey } from './settings';
import type { Provider } from './types';

/** The free assistant, signed in. A rejected sign-in signs the user out here too. */
export async function freeAssistant() {
  const { url, token } = await signedInToken();
  const provider = pawpaw(url, token);
  return {
    ...provider,
    complete: (...args: Parameters<Provider['complete']>) =>
      provider.complete(...args).catch(forgetIfSignedOut),
    listModels: (signal?: AbortSignal) =>
      provider.listModels(signal).catch(forgetIfSignedOut),
    usage: (signal?: AbortSignal) =>
      provider.usage(signal).catch(forgetIfSignedOut),
  };
}

/** The provider, with its key or sign-in. */
export async function providerFor(id: AssistantProvider): Promise<Provider> {
  if (id === 'pawpaw') return freeAssistant();
  if (!PROVIDERS[id]?.needsKey) throw new Error('Unknown provider.');
  // Development only: point a provider at a local stand-in server, to try the chat without
  // calling the real API, e.g. PAWPAW_ANTHROPIC_API=http://127.0.0.1:8787/v1.
  const local = app.isPackaged
    ? undefined
    : process.env[`PAWPAW_${id.toUpperCase()}_API`];
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
