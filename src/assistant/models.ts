// Model choices for each provider. No Electron imports.
import type { ProviderId } from './types';

export const PROVIDERS: Record<
  ProviderId,
  {
    name: string;
    product: string;
    /** Where to get an API key, or (for a local provider) the app itself. */
    url: string;
    /** False for Ollama: it runs on this computer and needs no key. */
    needsKey: boolean;
  }
> = {
  anthropic: {
    name: 'Anthropic',
    product: 'Claude',
    url: 'https://console.anthropic.com/settings/keys',
    needsKey: true,
  },
  openai: {
    name: 'OpenAI',
    product: 'ChatGPT',
    url: 'https://platform.openai.com/api-keys',
    needsKey: true,
  },
  ollama: {
    name: 'Ollama',
    product: 'Ollama',
    url: 'https://ollama.com/download',
    needsKey: false,
  },
};

/** Used until the provider's own list of models has been fetched. */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5',
  // Whatever the user has installed: chosen from Ollama's list.
  ollama: '',
};

/**
 * The model to use from a provider's list: the saved choice if it's still offered, else the
 * default if offered, else the most capable-looking one (for OpenAI, a full GPT model rather
 * than a mini or nano one).
 */
export function pickModel(
  provider: ProviderId,
  available: string[],
  saved?: string,
): string {
  if (saved && (available.includes(saved) || !available.length)) return saved;
  if (!available.length) return DEFAULT_MODELS[provider];
  if (available.includes(DEFAULT_MODELS[provider]))
    return DEFAULT_MODELS[provider];
  if (provider === 'ollama') return available[0];
  if (provider === 'anthropic') {
    return available.find((id) => id.includes('opus')) ?? available[0];
  }
  return (
    available.find((id) => /^gpt-\d/.test(id) && !/(mini|nano)/.test(id)) ??
    available[0]
  );
}
