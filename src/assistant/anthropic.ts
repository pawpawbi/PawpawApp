// Claude, through Anthropic's Messages API with streaming and tool use.
// https://docs.anthropic.com/en/api/messages
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

const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';
const NAME = 'Anthropic';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

interface Message {
  role: 'user' | 'assistant';
  content: Block[];
}

/**
 * The conversation in Anthropic's shape: tool results go in a user message, consecutive
 * messages from the same side are merged, it starts with the user, and every tool call has a
 * result (one cut short by a crash or Stop gets a "not run" result).
 */
export function toMessages(turns: Turn[]): Message[] {
  const messages: Message[] = [];
  const push = (role: Message['role'], blocks: Block[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  const answered = new Set(
    turns.flatMap((t) => (t.role === 'tool' ? [t.toolCallId] : [])),
  );
  for (const turn of turns) {
    if (turn.role === 'user') {
      push('user', [{ type: 'text', text: turn.text }]);
    } else if (turn.role === 'assistant') {
      const calls = turn.toolCalls ?? [];
      push('assistant', [
        ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
        ...calls.map((c) => ({
          type: 'tool_use' as const,
          id: c.id,
          name: c.name,
          input: c.input,
        })),
      ]);
      const missing = calls.filter((c) => !answered.has(c.id));
      push(
        'user',
        missing.map((c) => ({
          type: 'tool_result' as const,
          tool_use_id: c.id,
          content: NOT_RUN,
          is_error: true,
        })),
      );
    } else {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: turn.toolCallId,
          content: turn.content,
          ...(turn.isError ? { is_error: true } : {}),
        },
      ]);
    }
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  return messages;
}

/** The request body. The fixed instructions and the tools are marked for prompt caching. */
export function buildBody(request: ModelRequest) {
  const tools = request.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
  if (tools.length) {
    (tools[tools.length - 1] as Record<string, unknown>).cache_control = {
      type: 'ephemeral',
    };
  }
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    stream: true,
    system: [
      {
        type: 'text',
        text: request.system,
        cache_control: { type: 'ephemeral' },
      },
      ...(request.context ? [{ type: 'text', text: request.context }] : []),
    ],
    messages: toMessages(request.turns),
    tools,
  };
}

/** Collects a streamed response. */
export async function readResponse(
  events: AsyncIterable<ServerEvent>,
  onText: (text: string) => void,
): Promise<ModelResponse> {
  let text = '';
  const calls: (ToolCall & { json: string })[] = [];
  // Content block index -> the tool call it holds.
  const toolBlocks = new Map<number, ToolCall & { json: string }>();
  let stopReason = '';
  const usage = { input: 0, output: 0, cachedInput: 0 };

  for await (const { event, data } of events) {
    if (event === 'ping') continue;
    const payload = JSON.parse(data);
    switch (payload.type) {
      case 'message_start': {
        const u = payload.message?.usage ?? {};
        usage.input +=
          (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        usage.cachedInput += u.cache_read_input_tokens ?? 0;
        usage.output += u.output_tokens ?? 0;
        break;
      }
      case 'content_block_start': {
        const block = payload.content_block;
        if (block?.type === 'tool_use') {
          const call = { id: block.id, name: block.name, input: {}, json: '' };
          calls.push(call);
          toolBlocks.set(payload.index, call);
        } else if (block?.type === 'text') {
          if (block.text) {
            text += block.text;
            onText(block.text);
          }
        }
        break;
      }
      case 'content_block_delta': {
        const delta = payload.delta;
        if (delta?.type === 'text_delta') {
          text += delta.text;
          onText(delta.text);
        } else if (delta?.type === 'input_json_delta') {
          const call = toolBlocks.get(payload.index);
          if (call) call.json += delta.partial_json;
        }
        break;
      }
      case 'message_delta':
        stopReason = payload.delta?.stop_reason ?? stopReason;
        usage.output = payload.usage?.output_tokens ?? usage.output;
        break;
      case 'error':
        throw new ProviderError(
          `${NAME} stopped with an error: ${payload.error?.message ?? 'unknown error'}`,
        );
    }
  }

  const toolCalls = calls.map(({ json, ...call }) => ({
    ...call,
    input: parseToolInput(json),
  }));
  return {
    text,
    toolCalls,
    stop:
      stopReason === 'tool_use'
        ? 'tools'
        : stopReason === 'max_tokens'
          ? 'length'
          : stopReason === 'refusal'
            ? 'refused'
            : 'end',
    usage,
  };
}

export function anthropic(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  api = API,
): Provider {
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': VERSION,
    'content-type': 'application/json',
  };
  const explain = (status: number, detail: string) =>
    describeHttpError(NAME, status, detail);
  return {
    id: 'anthropic',
    async complete(request, onText, signal) {
      const response = await ensureOk(
        await fetchImpl(`${api}/messages`, {
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
        await fetchImpl(`${api}/models?limit=100`, { headers, signal }),
        explain,
      );
      const body = await response.json();
      return (body?.data ?? []).map((m: { id: string }) => m.id);
    },
  };
}
