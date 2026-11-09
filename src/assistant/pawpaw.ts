// The free assistant: Claude through the PawpawBI server, signed in with the user's PawpawBI
// account instead of an API key, within a monthly allowance (docs/pawpaw-server-api.md,
// "Assistant"). The server takes Anthropic's request and returns its stream unchanged, so this
// builds and reads them as anthropic.ts does. The server chooses the model; the app doesn't
// show it. No Electron imports.
import { SignedOutError } from '../pawpaw-server';
import { buildBody, readResponse } from './anthropic';
import { readEvents } from './sse';
import type { AllowanceUsage } from '../shared/types';
import { ProviderError, type Provider } from './types';

const NAME = 'The assistant';

interface Info {
  models: string[];
  maxTokens: number;
  usage: AllowanceUsage;
}

const OFFLINE =
  'Couldn’t reach PawpawBI. Check your internet connection and try again.';

/** A user-facing error for a refused request, from the server's error message. */
async function refused(response: Response): Promise<Error> {
  let message = '';
  try {
    const error = (await response.json())?.error;
    if (typeof error?.message === 'string') message = error.message;
  } catch {
    // Not JSON: described by the status below.
  }
  if (response.status === 401) {
    return new SignedOutError(
      'Sign in to PawpawBI again to use the free assistant.',
    );
  }
  if (message) return new ProviderError(message);
  return new ProviderError(
    `PawpawBI had a problem (${response.status}). Try again in a moment.`,
  );
}

export function pawpaw(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Provider & { usage: (signal?: AbortSignal) => Promise<AllowanceUsage> } {
  const base = baseUrl.replace(/\/+$/, '');
  const headers = {
    Authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };

  async function send(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ProviderError(OFFLINE);
    }
    if (!response.ok || !response.body) throw await refused(response);
    return response;
  }

  // Fetched once per provider (one reply): the model to use and the largest reply.
  let info: Promise<Info> | null = null;
  const getInfo = (signal?: AbortSignal) => {
    info ??= send('/assistant', { method: 'GET' }, signal).then(
      async (response) => {
        const body = await response.json();
        const models = Array.isArray(body?.models)
          ? body.models.filter((m: unknown) => typeof m === 'string')
          : [];
        if (!models.length) {
          throw new ProviderError(
            'The free assistant isn’t available right now. Try again later.',
          );
        }
        return {
          models,
          maxTokens: Number(body?.maxTokens) || 4096,
          usage: {
            share: Math.min(1, Math.max(0, Number(body?.usage?.share) || 0)),
            resetsAt: String(body?.usage?.resetsAt ?? ''),
          },
        };
      },
    );
    info.catch(() => (info = null));
    return info;
  };

  return {
    id: 'pawpaw',
    async complete(request, onText, signal) {
      const { models, maxTokens } = await getInfo(signal);
      const body = buildBody({
        ...request,
        model: models[0],
        maxTokens: Math.min(request.maxTokens, maxTokens),
      });
      const response = await send(
        '/assistant/messages',
        { method: 'POST', body: JSON.stringify(body) },
        signal,
      );
      return readResponse(
        readEvents(response.body as AsyncIterable<Uint8Array>),
        onText,
        NAME,
      );
    },
    async listModels(signal) {
      return (await getInfo(signal)).models;
    },
    async usage(signal) {
      info = null; // Always the latest.
      return (await getInfo(signal)).usage;
    },
  };
}
