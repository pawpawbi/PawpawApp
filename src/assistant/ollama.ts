// Local models through Ollama's native chat API, with streaming and tool calling. Nothing leaves
// the computer. https://github.com/ollama/ollama/blob/main/docs/api.md
//
// The native API (not Ollama's OpenAI-compatible one) is used because it can set the context
// window: Ollama's default is small, and the instructions, tools and tool results would be
// silently cut off.
import { ensureOk } from './http';
import { lines } from './sse';
import {
  NOT_RUN,
  ProviderError,
  parseToolInput,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type ToolCall,
  type Turn,
} from './types';

export const OLLAMA_URL = 'http://127.0.0.1:11434';
const NAME = 'Ollama';
/** The context window asked for, unless the model's own is smaller. */
export const CONTEXT_TOKENS = 16_384;

type Message =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      tool_calls?: {
        id: string;
        function: { name: string; arguments: Record<string, unknown> };
      }[];
    }
  | { role: 'tool'; tool_name: string; content: string };

/**
 * The conversation in Ollama's shape: each tool result follows the assistant message that asked
 * for it, and every tool call has a result (one cut short by a crash or Stop gets a "not run"
 * result).
 */
export function toMessages(
  system: string,
  context: string,
  turns: Turn[],
): Message[] {
  const messages: Message[] = [{ role: 'system', content: system }];
  if (context) messages.push({ role: 'system', content: context });
  const results = new Map(
    turns.flatMap((t) =>
      t.role === 'tool' ? [[t.toolCallId, t] as const] : [],
    ),
  );
  for (const turn of turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.text });
    } else if (turn.role === 'assistant') {
      const calls = turn.toolCalls ?? [];
      if (!turn.text && !calls.length) continue;
      messages.push({
        role: 'assistant',
        content: turn.text,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                function: { name: c.name, arguments: c.input },
              })),
            }
          : {}),
      });
      for (const call of calls) {
        messages.push({
          role: 'tool',
          tool_name: call.name,
          content: results.get(call.id)?.content ?? NOT_RUN,
        });
      }
    }
  }
  return messages;
}

export interface ModelInfo {
  /** Whether it can think before answering (turned off: too slow on most computers). */
  thinks: boolean;
  /** Its maximum context window, if known. */
  contextLength?: number;
  /** What it can do ("completion", "tools", "thinking"…), if Ollama says. */
  capabilities?: string[];
}

export function buildBody(request: ModelRequest, info: ModelInfo) {
  return {
    model: request.model,
    stream: true,
    messages: toMessages(request.system, request.context, request.turns),
    tools: request.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
    ...(info.thinks ? { think: false } : {}),
    options: {
      num_ctx: Math.min(CONTEXT_TOKENS, info.contextLength ?? CONTEXT_TOKENS),
      num_predict: request.maxTokens,
    },
  };
}

/** The non-empty lines of a byte stream (Ollama streams one JSON object per line). */
export async function* readLines(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  for await (const line of lines(body)) {
    if (line.trim()) yield line.trim();
  }
}

/** Collects a streamed response. */
export async function readResponse(
  lines: AsyncIterable<string>,
  onText: (text: string) => void,
): Promise<ModelResponse> {
  let text = '';
  const toolCalls: ToolCall[] = [];
  let doneReason = '';
  const usage = { input: 0, output: 0, cachedInput: 0 };

  for await (const line of lines) {
    const chunk = JSON.parse(line);
    if (chunk.error) {
      throw new ProviderError(`${NAME} stopped with an error: ${chunk.error}`);
    }
    const message = chunk.message ?? {};
    if (typeof message.content === 'string' && message.content) {
      text += message.content;
      onText(message.content);
    }
    for (const call of message.tool_calls ?? []) {
      toolCalls.push({
        id:
          call.id || `call_${toolCalls.length + 1}_${Date.now().toString(36)}`,
        name: String(call.function?.name ?? ''),
        input: parseToolInput(call.function?.arguments),
      });
    }
    if (chunk.done) {
      doneReason = chunk.done_reason ?? '';
      usage.input = chunk.prompt_eval_count ?? 0;
      usage.output = chunk.eval_count ?? 0;
    }
  }
  // Ollama says "stop" even when the model asked for tools, so go by the calls themselves.
  return {
    text,
    toolCalls,
    stop: toolCalls.length
      ? 'tools'
      : doneReason === 'length'
        ? 'length'
        : 'end',
    usage,
  };
}

/** A user-facing message for an error from Ollama. */
export function describeOllamaError(
  status: number,
  detail: string,
  model?: string,
): string {
  if (status === 404 && /not found/i.test(detail)) {
    return `Ollama doesn't have the model ${model ?? ''}. Choose another in Assistant settings, or download it with "ollama pull ${model ?? '<model>'}".`;
  }
  if (/does not support tools/i.test(detail)) {
    return `The model ${model ?? ''} can't use tools, which the assistant needs. Choose another in Assistant settings.`;
  }
  return `Ollama refused the request (${status})${detail ? `: ${detail}` : '.'}`;
}

const NOT_RUNNING =
  "Ollama isn't running on this computer. Start Ollama (or install it from ollama.com), then try again.";

export function ollama(
  base = OLLAMA_URL,
  fetchImpl: typeof fetch = fetch,
): Provider {
  const info = new Map<string, Promise<ModelInfo>>();

  /** fetch, with "can't connect" explained. Stopping (abort) passes through unchanged. */
  async function call(path: string, init: RequestInit) {
    try {
      return await fetchImpl(`${base}${path}`, init);
    } catch (error) {
      if (
        (error as Error)?.name === 'AbortError' ||
        (error as Error)?.name === 'TimeoutError'
      ) {
        throw error;
      }
      throw new ProviderError(NOT_RUNNING);
    }
  }

  function modelInfo(model: string, signal?: AbortSignal): Promise<ModelInfo> {
    if (!info.has(model)) {
      const request = (async () => {
        const response = await call('/api/show', {
          method: 'POST',
          body: JSON.stringify({ model }),
          signal,
        });
        if (!response.ok) return { thinks: false };
        const body = await response.json();
        const length = Object.entries(body?.model_info ?? {}).find(([key]) =>
          key.endsWith('.context_length'),
        )?.[1];
        const capabilities = Array.isArray(body?.capabilities)
          ? (body.capabilities as string[])
          : undefined;
        return {
          thinks: capabilities?.includes('thinking') ?? false,
          contextLength: typeof length === 'number' ? length : undefined,
          capabilities,
        };
      })();
      request.catch(() => info.delete(model));
      info.set(model, request);
    }
    return info.get(model)!;
  }

  return {
    id: 'ollama',
    async complete(request, onText, signal) {
      const details = await modelInfo(request.model, signal);
      const response = await ensureOk(
        await call('/api/chat', {
          method: 'POST',
          body: JSON.stringify(buildBody(request, details)),
          signal,
        }),
        (status, detail) => describeOllamaError(status, detail, request.model),
      );
      return readResponse(
        readLines(response.body as AsyncIterable<Uint8Array>),
        onText,
      );
    },
    /** Installed models that can use tools, most recently downloaded first. */
    async listModels(signal) {
      const response = await ensureOk(
        await call('/api/tags', { signal }),
        describeOllamaError,
      );
      const names: string[] = ((await response.json())?.models ?? []).map(
        (m: { name: string }) => m.name,
      );
      if (!names.length) {
        throw new ProviderError(
          'Ollama has no models yet. Download one that can use tools, for example with "ollama pull qwen3".',
        );
      }
      const usable: string[] = [];
      for (const name of names) {
        // Older Ollama versions don't list capabilities: offer the model and let a failure say so.
        const { capabilities } = await modelInfo(name, signal);
        if (!capabilities || capabilities.includes('tools')) usable.push(name);
      }
      if (!usable.length) {
        throw new ProviderError(
          'None of the models in Ollama can use tools, which the assistant needs. Download one that can, for example with "ollama pull qwen3".',
        );
      }
      return usable;
    },
  };
}
