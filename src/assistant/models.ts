// The assistant's providers, and model choices for those with a key. No Electron imports.
import type { ProviderId } from './types';

export const PROVIDERS: Record<
  ProviderId,
  {
    name: string;
    product: string;
    /** Where to get an API key, or (for PawpawBI) the website. */
    url: string;
    /** False for PawpawBI: it needs a PawpawBI account instead. */
    needsKey: boolean;
  }
> = {
  pawpaw: {
    name: 'PawpawBI',
    product: 'PawpawBI',
    url: 'https://pawpawbi.com',
    needsKey: false,
  },
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
};

/** The provider for anyone who hasn't chosen one: the free assistant. */
export const DEFAULT_PROVIDER: ProviderId = 'pawpaw';

/**
 * Used until the provider's own list of models has been fetched. PawpawBI chooses its own model,
 * which the app doesn't show.
 */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  pawpaw: '',
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5',
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
  if (provider === 'pawpaw') return '';
  if (saved && (available.includes(saved) || !available.length)) return saved;
  if (!available.length) return DEFAULT_MODELS[provider];
  if (available.includes(DEFAULT_MODELS[provider]))
    return DEFAULT_MODELS[provider];
  if (provider === 'anthropic') {
    return available.find((id) => id.includes('opus')) ?? available[0];
  }
  return (
    available.find((id) => /^gpt-\d/.test(id) && !/(mini|nano)/.test(id)) ??
    available[0]
  );
}
