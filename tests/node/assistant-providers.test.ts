// The provider adapters (src/assistant/anthropic.ts, openai.ts) and the event-stream parser.
// Streams below follow each API's documented format; requests are checked for the shape each
// API requires.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as claude from '../../src/assistant/anthropic.ts';
import * as local from '../../src/assistant/ollama.ts';
import * as gpt from '../../src/assistant/openai.ts';
import { readEvents } from '../../src/assistant/sse.ts';
import type { ModelRequest, Turn } from '../../src/assistant/types.ts';

/** A byte stream delivered in the given pieces. */
async function* chunks(...pieces: string[]) {
  for (const p of pieces) yield new TextEncoder().encode(p);
}

const collect = async <T>(items: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
};

/** Splits a stream at every n characters, to check nothing depends on chunk boundaries. */
const sliced = (text: string, n: number) =>
  chunks(
    ...Array.from({ length: Math.ceil(text.length / n) }, (_, i) =>
      text.slice(i * n, i * n + n),
    ),
  );

// --- Server-sent events -------------------------------------------------------------------

test('events are read across chunk boundaries, including a split \\r\\n', async () => {
  const events = await collect(
    readEvents(
      chunks(
        'event: a\r',
        '\ndata: {"x":',
        '1}\r\n\r\n: comment\n',
        'data: two\ndata: lines\n\n',
        'data: last',
      ),
    ),
  );
  assert.deepEqual(events, [
    { event: 'a', data: '{"x":1}' },
    { event: 'message', data: 'two\nlines' },
    { event: 'message', data: 'last' },
  ]);
});

// --- Shared conversation --------------------------------------------------------------------

const call = {
  id: 'call_1',
  name: 'preview_table',
  input: { table: 'orders' },
};
const turns: Turn[] = [
  { role: 'assistant', text: 'Hi! Where does your data live?' },
  { role: 'user', text: 'Show me orders' },
  {
    role: 'assistant',
    text: 'Looking.',
    toolCalls: [call, { id: 'call_2', name: 'list_tables', input: {} }],
  },
  {
    role: 'tool',
    toolCallId: 'call_1',
    name: 'preview_table',
    content: '{"rows":[]}',
  },
  {
    role: 'tool',
    toolCallId: 'call_2',
    name: 'list_tables',
    content: 'boom',
    isError: true,
  },
  { role: 'assistant', text: 'It has no rows.' },
  { role: 'user', text: 'Thanks' },
];

const request: ModelRequest = {
  model: 'm',
  system: 'Be helpful.',
  context: 'Project: Sales.',
  turns,
  tools: [
    {
      name: 'list_tables',
      description: 'List',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'preview_table',
      description: 'Preview',
      parameters: { type: 'object', properties: {} },
    },
  ],
  maxTokens: 1000,
};

// --- Anthropic ----------------------------------------------------------------------------

test('Anthropic: tool results go together in one user message; it starts with the user', () => {
  const messages = claude.toMessages(turns);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'user'],
  );
  assert.deepEqual(
    messages[1].content.map((b) => b.type),
    ['text', 'tool_use', 'tool_use'],
  );
  assert.deepEqual(messages[2].content, [
    { type: 'tool_result', tool_use_id: 'call_1', content: '{"rows":[]}' },
    {
      type: 'tool_result',
      tool_use_id: 'call_2',
      content: 'boom',
      is_error: true,
    },
  ]);
});

test('Anthropic: a tool call left without a result gets a "not run" result', () => {
  const messages = claude.toMessages([
    { role: 'user', text: 'Go' },
    { role: 'assistant', text: '', toolCalls: [call] },
  ]);
  assert.equal(messages.length, 3);
  assert.equal(messages[2].role, 'user');
  assert.match(JSON.stringify(messages[2].content), /not run/);
});

test('Anthropic: the fixed instructions and tools are cached; the project context is not', () => {
  const body = claude.buildBody(request);
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 1000);
  assert.deepEqual(body.system, [
    { type: 'text', text: 'Be helpful.', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Project: Sales.' },
  ]);
  assert.deepEqual(body.tools[1], {
    name: 'preview_table',
    description: 'Preview',
    input_schema: { type: 'object', properties: {} },
    cache_control: { type: 'ephemeral' },
  });
  assert.equal('cache_control' in body.tools[0], false);
});

const anthropicStream = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":12,"cache_creation_input_tokens":3,"cache_read_input_tokens":900,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: ping',
  'data: {"type": "ping"}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me "}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"check."}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"preview_table","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"table\\": \\"or"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ders\\", \\"limit\\": 5}"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":1}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":40}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

test('Anthropic: a streamed reply with text and a tool call', async () => {
  const streamed: string[] = [];
  const response = await claude.readResponse(
    readEvents(sliced(anthropicStream, 7)),
    (t) => streamed.push(t),
  );
  assert.equal(streamed.join(''), 'Let me check.');
  assert.equal(response.text, 'Let me check.');
  assert.deepEqual(response.toolCalls, [
    {
      id: 'toolu_1',
      name: 'preview_table',
      input: { table: 'orders', limit: 5 },
    },
  ]);
  assert.equal(response.stop, 'tools');
  assert.deepEqual(response.usage, { input: 15, output: 40, cachedInput: 900 });
});

test('Anthropic: an error event mid-stream becomes an error', async () => {
  const stream =
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
  await assert.rejects(
    claude.readResponse(readEvents(chunks(stream)), () => {}),
    /Overloaded/,
  );
});

test('Anthropic: HTTP errors are explained, and the key goes in the x-api-key header', async () => {
  let seen: Headers | undefined;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    seen = new Headers(init.headers);
    return new Response(
      JSON.stringify({ error: { message: 'invalid x-api-key' } }),
      { status: 401 },
    );
  }) as typeof fetch;
  const provider = claude.anthropic('sk-ant-test', fakeFetch);
  await assert.rejects(
    provider.complete(request, () => {}, new AbortController().signal),
    /didn't accept the API key/,
  );
  assert.equal(seen?.get('x-api-key'), 'sk-ant-test');
  assert.equal(seen?.get('anthropic-version'), '2023-06-01');
});

// --- OpenAI -------------------------------------------------------------------------------

test('OpenAI: system messages first, and each tool result follows its call', () => {
  const messages = gpt.toMessages('Be helpful.', 'Project: Sales.', turns);
  assert.deepEqual(
    messages.map((m) => m.role),
    [
      'system',
      'system',
      'assistant',
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
      'user',
    ],
  );
  const asking = messages[4] as {
    tool_calls: { id: string; function: { arguments: string } }[];
  };
  assert.deepEqual(
    asking.tool_calls.map((c) => c.id),
    ['call_1', 'call_2'],
  );
  assert.equal(asking.tool_calls[0].function.arguments, '{"table":"orders"}');
  assert.deepEqual(messages[5], {
    role: 'tool',
    tool_call_id: 'call_1',
    content: '{"rows":[]}',
  });
});

test('OpenAI: a tool call left without a result gets a "not run" result', () => {
  const messages = gpt.toMessages('s', '', [
    { role: 'user', text: 'Go' },
    { role: 'assistant', text: '', toolCalls: [call] },
  ]);
  assert.equal(messages[messages.length - 1].role, 'tool');
  assert.match(JSON.stringify(messages[messages.length - 1]), /not run/);
});

test('OpenAI: the request asks for streaming with usage, and tools as functions', () => {
  const body = gpt.buildBody(request);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_completion_tokens, 1000);
  assert.deepEqual(body.tools?.[0], {
    type: 'function',
    function: {
      name: 'list_tables',
      description: 'List',
      parameters: { type: 'object', properties: {} },
    },
  });
});

const openaiStream = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Let me "},"finish_reason":null}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"check."},"finish_reason":null}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"preview_table","arguments":""}}]},"finish_reason":null}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"table\\":\\"ord"}}]},"finish_reason":null}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"list_tables","arguments":"{}"}}]},"finish_reason":null}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ers\\"}"}}]},"finish_reason":null}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":800}}}',
  'data: [DONE]',
  '',
  '',
].join('\n\n');

test('OpenAI: a streamed reply with text and two tool calls', async () => {
  const streamed: string[] = [];
  const response = await gpt.readResponse(
    readEvents(sliced(openaiStream, 11)),
    (t) => streamed.push(t),
  );
  assert.equal(streamed.join(''), 'Let me check.');
  assert.deepEqual(response.toolCalls, [
    { id: 'call_a', name: 'preview_table', input: { table: 'orders' } },
    { id: 'call_b', name: 'list_tables', input: {} },
  ]);
  assert.equal(response.stop, 'tools');
  assert.deepEqual(response.usage, {
    input: 200,
    output: 30,
    cachedInput: 800,
  });
});

test('OpenAI: a refusal is shown as the reply', async () => {
  const stream =
    'data: {"choices":[{"index":0,"delta":{"refusal":"I can\'t help with that."},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const response = await gpt.readResponse(readEvents(chunks(stream)), () => {});
  assert.equal(response.text, "I can't help with that.");
  assert.equal(response.stop, 'refused');
});

test('OpenAI: only chat models are offered', () => {
  assert.deepEqual(
    gpt.chatModels([
      'gpt-5',
      'gpt-5-mini',
      'text-embedding-3-large',
      'gpt-4o-realtime-preview',
      'dall-e-3',
      'o4-mini',
      'gpt-image-1',
      'whisper-1',
    ]),
    ['o4-mini', 'gpt-5-mini', 'gpt-5'],
  );
});

test('OpenAI: the key goes in a bearer header and a missing model is explained', async () => {
  let seen: Headers | undefined;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    seen = new Headers(init.headers);
    return new Response(
      JSON.stringify({ error: { message: 'The model `nope` does not exist' } }),
      { status: 404 },
    );
  }) as typeof fetch;
  await assert.rejects(
    gpt
      .openai('sk-test', fakeFetch)
      .complete(request, () => {}, new AbortController().signal),
    /couldn't find that model/,
  );
  assert.equal(seen?.get('authorization'), 'Bearer sk-test');
});

// --- Ollama (shapes as returned by Ollama 0.17.7) -------------------------------------------

test('Ollama: system first, each tool result follows its call by tool name', () => {
  const messages = local.toMessages('Be helpful.', 'Project: Sales.', turns);
  assert.deepEqual(
    messages.map((m) => m.role),
    [
      'system',
      'system',
      'assistant',
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
      'user',
    ],
  );
  assert.deepEqual(messages[4], {
    role: 'assistant',
    content: 'Looking.',
    tool_calls: [
      {
        id: 'call_1',
        function: { name: 'preview_table', arguments: { table: 'orders' } },
      },
      { id: 'call_2', function: { name: 'list_tables', arguments: {} } },
    ],
  });
  assert.deepEqual(messages[5], {
    role: 'tool',
    tool_name: 'preview_table',
    content: '{"rows":[]}',
  });
});

test('Ollama: the context window is set, never above the model’s; thinking is turned off', () => {
  const thinker = local.buildBody(request, {
    thinks: true,
    contextLength: 262144,
  });
  assert.equal(thinker.options.num_ctx, local.CONTEXT_TOKENS);
  assert.equal(thinker.options.num_predict, 1000);
  assert.equal(thinker.think, false);
  assert.equal(thinker.tools[0].function.name, 'list_tables');

  const small = local.buildBody(request, {
    thinks: false,
    contextLength: 4096,
  });
  assert.equal(small.options.num_ctx, 4096);
  assert.equal(
    'think' in small,
    false,
    'models that can’t think are not sent the option',
  );
});

const ollamaStream = [
  '{"model":"qwen3.5:2b","message":{"role":"assistant","content":"Let me "},"done":false}',
  '{"model":"qwen3.5:2b","message":{"role":"assistant","content":"check."},"done":false}',
  '{"model":"qwen3.5:2b","message":{"role":"assistant","content":"","tool_calls":[{"id":"call_gvesv5is","function":{"index":0,"name":"count_rows","arguments":{"table":"orders"}}}]},"done":false}',
  '{"model":"qwen3.5:2b","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"list_tables","arguments":{}}}]},"done":false}',
  '{"model":"qwen3.5:2b","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":291,"eval_count":26}',
  '',
].join('\n');

test('Ollama: a streamed reply with text and tool calls, even though it says "stop"', async () => {
  const streamed: string[] = [];
  const response = await local.readResponse(
    local.readLines(sliced(ollamaStream, 13)),
    (t) => streamed.push(t),
  );
  assert.equal(streamed.join(''), 'Let me check.');
  assert.equal(response.stop, 'tools');
  assert.deepEqual(response.toolCalls[0], {
    id: 'call_gvesv5is',
    name: 'count_rows',
    input: { table: 'orders' },
  });
  assert.equal(response.toolCalls[1].name, 'list_tables');
  assert.match(
    response.toolCalls[1].id,
    /^call_/,
    'a call without an ID is given one',
  );
  assert.deepEqual(response.usage, { input: 291, output: 26, cachedInput: 0 });
});

test('Ollama: an error line mid-stream becomes an error', async () => {
  await assert.rejects(
    local.readResponse(
      local.readLines(chunks('{"error":"out of memory"}\n')),
      () => {},
    ),
    /out of memory/,
  );
});

/** A fake Ollama server: answers by path. */
const fakeOllama = (routes: Record<string, (body: any) => Response>) =>
  (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const handler = routes[path];
    if (!handler) return new Response('{"error":"not found"}', { status: 404 });
    return handler(init?.body ? JSON.parse(String(init.body)) : null);
  }) as typeof fetch;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

test('Ollama: only installed models that can use tools are offered', async () => {
  const provider = local.ollama(
    'http://ollama.test',
    fakeOllama({
      '/api/tags': () =>
        json({
          models: [
            { name: 'qwen3:8b' },
            { name: 'deepseek-r1:latest' },
            { name: 'old:7b' },
          ],
        }),
      '/api/show': (body) =>
        json(
          body.model === 'qwen3:8b'
            ? { capabilities: ['completion', 'tools', 'thinking'] }
            : body.model === 'deepseek-r1:latest'
              ? { capabilities: ['completion'] }
              : {}, // An older Ollama: no capabilities listed.
        ),
    }),
  );
  assert.deepEqual(await provider.listModels(), ['qwen3:8b', 'old:7b']);
});

test('Ollama: no models, or none that can use tools, say what to do', async () => {
  const none = local.ollama(
    'http://ollama.test',
    fakeOllama({ '/api/tags': () => json({ models: [] }) }),
  );
  await assert.rejects(none.listModels(), /no models yet.*ollama pull/);
  const noTools = local.ollama(
    'http://ollama.test',
    fakeOllama({
      '/api/tags': () => json({ models: [{ name: 'deepseek-r1:latest' }] }),
      '/api/show': () => json({ capabilities: ['completion'] }),
    }),
  );
  await assert.rejects(noTools.listModels(), /can use tools/);
});

test('Ollama: not running, a missing model and stopping are each handled', async () => {
  const refused = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(
    local.ollama('http://ollama.test', refused).listModels(),
    /isn't running/,
  );

  const missing = local.ollama(
    'http://ollama.test',
    fakeOllama({
      '/api/show': () => json({ error: "model 'nope' not found" }, 404),
      '/api/chat': () => json({ error: "model 'nope' not found" }, 404),
    }),
  );
  await assert.rejects(
    missing.complete(
      { ...request, model: 'nope' },
      () => {},
      new AbortController().signal,
    ),
    /doesn't have the model nope.*ollama pull nope/,
  );

  const aborted = (async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }) as typeof fetch;
  await assert.rejects(
    local
      .ollama('http://ollama.test', aborted)
      .complete(request, () => {}, new AbortController().signal),
    (error: Error) => error.name === 'AbortError',
  );
});
