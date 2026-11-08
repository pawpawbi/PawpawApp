// What the provider adapters share: checking a response and explaining an HTTP error to the
// user. No Electron imports.
import { ProviderError } from './types';

/** The error message in a provider's response body, if there is one. */
export async function errorDetail(response: Response): Promise<string> {
  try {
    const error = (await response.json())?.error;
    return String((typeof error === 'string' ? error : error?.message) ?? '');
  } catch {
    return '';
  }
}

/** A user-facing message for an HTTP error from a provider. */
export function describeHttpError(
  provider: string,
  status: number,
  detail: string,
): string {
  if (status === 401 || status === 403) {
    return `${provider} didn't accept the API key. Check it was copied in full, or create a new one.`;
  }
  if (status === 404) {
    return `${provider} couldn't find that model. Choose another one in Assistant settings.${detail ? ` (${detail})` : ''}`;
  }
  if (status === 429) {
    return `${provider} is limiting requests on this key (rate limit or credit). Wait a moment, or check your account.${detail ? ` (${detail})` : ''}`;
  }
  if (status >= 500) {
    return `${provider} had a problem (${status}). Try again in a moment.`;
  }
  return `${provider} refused the request (${status})${detail ? `: ${detail}` : '.'}`;
}

/** The response, or a ProviderError explained by `describe` if it isn't OK. */
export async function ensureOk(
  response: Response,
  describe: (status: number, detail: string) => string,
): Promise<Response> {
  if (!response.ok || !response.body) {
    throw new ProviderError(
      describe(response.status, await errorDetail(response)),
    );
  }
  return response;
}
