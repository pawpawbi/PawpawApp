// ChatGPT, through OpenAI's Chat Completions API with streaming and function calling.
// https://platform.openai.com/docs/api-reference/chat
import { describeHttpError, ensureOk } from './http';
import { readEvents, type ServerEvent } from './sse';
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

const API = 'https://api.openai.com/v1';
const NAME = 'OpenAI';

type Message =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * The conversation in OpenAI's shape: each tool result follows the assistant message that
 * asked for it, and every tool call has a result (one cut short by a crash or Stop gets a "not
 * run" result).
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
        content: turn.text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      });
      for (const call of calls) {
        const result = results.get(call.id);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result ? result.content : NOT_RUN,
        });
      }
    }
    // Tool turns are placed after their assistant message above.
  }
  return messages;
}

export function buildBody(request: ModelRequest) {
  return {
    model: request.model,
    messages: toMessages(request.system, request.context, request.turns),
    ...(request.tools.length
      ? {
          tools: request.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
        }
      : {}),
    max_completion_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
}

/** Collects a streamed response. */
export async function readResponse(
  events: AsyncIterable<ServerEvent>,
  onText: (text: string) => void,
): Promise<ModelResponse> {
  let text = '';
  let refusal = '';
  const calls = new Map<number, ToolCall & { json: string }>();
  let finish = '';
  const usage = { input: 0, output: 0, cachedInput: 0 };

  for await (const { data } of events) {
    if (data === '[DONE]') break;
    const chunk = JSON.parse(data);
    if (chunk.error) {
      throw new ProviderError(
        `${NAME} stopped with an error: ${chunk.error.message ?? 'unknown error'}`,
      );
    }
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      usage.input = (chunk.usage.prompt_tokens ?? 0) - cached;
      usage.cachedInput = cached;
      usage.output = chunk.usage.completion_tokens ?? 0;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      onText(delta.content);
    }
    if (typeof delta.refusal === 'string') refusal += delta.refusal;
    for (const part of delta.tool_calls ?? []) {
      let call = calls.get(part.index);
      if (!call) {
        call = { id: '', name: '', input: {}, json: '' };
        calls.set(part.index, call);
      }
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name += part.function.name;
      if (part.function?.arguments) call.json += part.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  if (refusal && !text) {
    text = refusal;
    onText(refusal);
  }
  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, { json, ...call }]) => ({ ...call, input: parseToolInput(json) }));
  return {
    text,
    toolCalls,
    stop:
      finish === 'tool_calls' || (toolCalls.length && finish !== 'length')
        ? 'tools'
        : finish === 'length'
          ? 'length'
          : refusal || finish === 'content_filter'
            ? 'refused'
            : 'end',
    usage,
  };
}

/** Models that can chat with tools: leaves out audio, image, embedding and similar models. */
export function chatModels(ids: string[]): string[] {
  return ids
    .filter(
      (id) =>
        /^(gpt-|o\d|chatgpt-)/.test(id) &&
        !/(audio|realtime|transcribe|tts|image|embedding|search|moderation|instruct|codex)/.test(
          id,
        ),
    )
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

export function openai(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  api = API,
): Provider {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  };
  const explain = (status: number, detail: string) =>
    describeHttpError(NAME, status, detail);
  return {
    id: 'openai',
    async complete(request, onText, signal) {
      const response = await ensureOk(
        await fetchImpl(`${api}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(buildBody(request)),
          signal,
        }),
        explain,
      );
      return readResponse(
        readEvents(response.body as AsyncIterable<Uint8Array>),
        onText,
      );
    },
    async listModels(signal) {
      const response = await ensureOk(
        await fetchImpl(`${api}/models`, { headers, signal }),
        explain,
      );
      const body = await response.json();
      return chatModels((body?.data ?? []).map((m: { id: string }) => m.id));
    },
  };
}
