// The assistant's tool loop (src/assistant/loop.ts), conversation history (history.ts), model
// choice (models.ts) and reply formatting (chat-format.ts), with a scripted fake provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocks, inline } from '../../src/chat-format.ts';
import { NO_REPLY, toTurns } from '../../src/assistant/history.ts';
import {
  MAX_RESULT_CHARS,
  NOT_ALLOWED,
  resultText,
  runAssistant,
} from '../../src/assistant/loop.ts';
import { pickModel } from '../../src/assistant/models.ts';
import type {
  ModelRequest,
  ModelResponse,
  Provider,
  ToolSpec,
  Turn,
} from '../../src/assistant/types.ts';
import type { ChatMessage } from '../../src/shared/types.ts';

const usage = { input: 0, output: 0, cachedInput: 0 };

/** A provider that gives scripted responses and records each request. */
function scripted(
  ...responses: (
    | Partial<ModelResponse>
    | ((
        signal: AbortSignal,
        onText: (t: string) => void,
      ) => Promise<ModelResponse>)
  )[]
) {
  const requests: ModelRequest[] = [];
  const provider: Provider = {
    id: 'anthropic',
    listModels: async () => [],
    async complete(request, onText, signal) {
      requests.push(structuredClone(request));
      const next = responses.shift();
      if (!next) throw new Error('No more responses');
      if (typeof next === 'function') return next(signal, onText);
      if (next.text) onText(next.text);
      return { text: '', toolCalls: [], stop: 'end', usage, ...next };
    },
  };
  return { provider, requests };
}

const tool = (name: string, run: ToolSpec['run']): ToolSpec => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  describe: () => `Doing ${name}`,
  run,
});

const start: Turn[] = [{ role: 'user', text: 'How many orders?' }];

async function run(
  provider: Provider,
  tools: ToolSpec[],
  extra: Partial<Parameters<typeof runAssistant>[0]> = {},
) {
  const saved: Turn[] = [];
  const events: string[] = [];
  const end = await runAssistant({
    provider,
    model: 'm',
    system: 's',
    context: 'c',
    tools,
    history: start,
    signal: new AbortController().signal,
    onTurn: (t) => {
      saved.push(t);
    },
    onToolStart: (c, summary) => events.push(`start ${c.name}: ${summary}`),
    onToolEnd: (c, ok) => events.push(`end ${c.name}: ${ok}`),
    ...extra,
  });
  return { end, saved, events };
}

test('runs the tools the model asks for and gives it the results', async () => {
  const { provider, requests } = scripted(
    {
      text: 'Checking.',
      toolCalls: [{ id: 'a', name: 'count', input: { table: 'orders' } }],
      stop: 'tools',
    },
    { text: 'There are 400 orders.' },
  );
  let input: unknown;
  const { end, saved, events } = await run(provider, [
    tool('count', async (i) => {
      input = i;
      return { rows: 400 };
    }),
  ]);
  assert.equal(end, 'end');
  assert.deepEqual(input, { table: 'orders' });
  assert.deepEqual(saved, [
    {
      role: 'assistant',
      text: 'Checking.',
      toolCalls: [{ id: 'a', name: 'count', input: { table: 'orders' } }],
    },
    { role: 'tool', toolCallId: 'a', name: 'count', content: '{"rows":400}' },
    { role: 'assistant', text: 'There are 400 orders.' },
  ]);
  assert.deepEqual(events, ['start count: Doing count', 'end count: true']);
  // The second request carries the whole exchange.
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[1].turns.map((t) => t.role),
    ['user', 'assistant', 'tool'],
  );
  assert.deepEqual(
    requests[1].tools.map((t) => t.name),
    ['count'],
  );
});

test('a failing or unknown tool is reported back to the model, not thrown', async () => {
  const { provider } = scripted(
    {
      toolCalls: [
        { id: 'a', name: 'broken', input: {} },
        { id: 'b', name: 'missing', input: {} },
      ],
      stop: 'tools',
    },
    { text: 'Sorry, that failed.' },
  );
  const { end, saved } = await run(provider, [
    tool('broken', async () => {
      throw new Error('No table called "x".');
    }),
  ]);
  assert.equal(end, 'end');
  assert.deepEqual(saved.slice(1, 3), [
    {
      role: 'tool',
      toolCallId: 'a',
      name: 'broken',
      content: 'No table called "x".',
      isError: true,
    },
    {
      role: 'tool',
      toolCallId: 'b',
      name: 'missing',
      content: "There's no tool called missing.",
      isError: true,
    },
  ]);
});

test('stops after the step limit', async () => {
  const again = () => ({
    toolCalls: [{ id: crypto.randomUUID(), name: 'count', input: {} }],
    stop: 'tools' as const,
  });
  const { provider } = scripted(again(), again(), again());
  const { end, saved } = await run(provider, [tool('count', async () => 1)], {
    maxSteps: 3,
  });
  assert.equal(end, 'steps');
  assert.equal(saved.filter((t) => t.role === 'tool').length, 3);
});

test('stopping keeps the text written so far', async () => {
  const controller = new AbortController();
  const { provider } = scripted(async (signal, onText) => {
    onText('Half a');
    controller.abort();
    assert.ok(signal.aborted);
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  const { end, saved } = await run(provider, [], { signal: controller.signal });
  assert.equal(end, 'stopped');
  assert.deepEqual(saved, [{ role: 'assistant', text: 'Half a' }]);
});

test('provider errors are thrown, after nothing half-saved', async () => {
  const { provider } = scripted(async () => {
    throw new Error("Anthropic didn't accept the API key.");
  });
  await assert.rejects(run(provider, []), /didn't accept/);
});

test('long tool results are cut short with a note', () => {
  const text = resultText('x'.repeat(MAX_RESULT_CHARS + 10));
  assert.equal(text.startsWith('x'.repeat(MAX_RESULT_CHARS)), true);
  assert.match(text, /Cut short/);
  assert.equal(resultText({ a: 1 }), '{"a":1}');
  assert.equal(resultText(undefined), 'null');
});

// --- History --------------------------------------------------------------------------------

const msg = (
  role: ChatMessage['role'],
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: crypto.randomUUID(),
  createdAt: '',
  role,
  text,
  ...extra,
});

test('saved messages become turns, starting at a user message', () => {
  const turns = toTurns([
    msg('tool', 'orphan result', { toolCallId: 'z' }),
    msg('assistant', 'Welcome'),
    msg('user', 'Hi'),
    msg('assistant', '', {
      toolCalls: [{ id: 'a', name: 'list_tables', input: {} }],
    }),
    msg('tool', '[]', {
      toolCallId: 'a',
      toolName: 'list_tables',
      summary: 'Looking',
    }),
    msg('assistant', 'No tables yet.'),
  ]);
  assert.deepEqual(turns, [
    { role: 'user', text: 'Hi' },
    {
      role: 'assistant',
      text: '',
      toolCalls: [{ id: 'a', name: 'list_tables', input: {} }],
    },
    { role: 'tool', toolCallId: 'a', name: 'list_tables', content: '[]' },
    { role: 'assistant', text: 'No tables yet.' },
  ]);
});

// --- Models -----------------------------------------------------------------------------------

test('the model choice prefers the saved one, then the default, then a capable one', () => {
  assert.equal(pickModel('anthropic', ['claude-opus-5-5', 'x'], 'x'), 'x');
  assert.equal(
    pickModel('anthropic', ['claude-opus-5-5'], 'gone'),
    'claude-opus-5-5',
  );
  assert.equal(pickModel('anthropic', [], 'saved'), 'saved');
  assert.equal(pickModel('anthropic', [], undefined), 'claude-opus-5-5');
  assert.equal(
    pickModel('anthropic', ['claude-haiku-9', 'claude-opus-9']),
    'claude-opus-9',
  );
  assert.equal(
    pickModel('openai', ['o4-mini', 'gpt-6-mini', 'gpt-6']),
    'gpt-6',
  );
});

// --- Formatting -------------------------------------------------------------------------------

test('replies are split into text and code, with inline code and bold', () => {
  assert.deepEqual(blocks('Try this:\n```sql\nSELECT 1\n```\nDone **now**.'), [
    { kind: 'text', parts: [{ kind: 'text', text: 'Try this:' }] },
    { kind: 'code', language: 'sql', text: 'SELECT 1' },
    {
      kind: 'text',
      parts: [
        { kind: 'text', text: 'Done ' },
        { kind: 'bold', text: 'now' },
        { kind: 'text', text: '.' },
      ],
    },
  ]);
  // Still streaming: the fence isn't closed yet.
  assert.deepEqual(blocks('```html\n<p>'), [
    { kind: 'code', language: 'html', text: '<p>' },
  ]);
  assert.deepEqual(inline('use `orders` table'), [
    { kind: 'text', text: 'use ' },
    { kind: 'code', text: 'orders' },
    { kind: 'text', text: ' table' },
  ]);
  assert.deepEqual(inline('<script>alert(1)</script>'), [
    { kind: 'text', text: '<script>alert(1)</script>' },
  ]);
});

test('Ollama has no default model: the first installed one that can use tools is used', () => {
  assert.equal(pickModel('ollama', [], undefined), '');
  assert.equal(pickModel('ollama', ['qwen3:8b', 'qwen3.5:2b']), 'qwen3:8b');
  assert.equal(
    pickModel('ollama', ['qwen3:8b', 'qwen3.5:2b'], 'qwen3.5:2b'),
    'qwen3.5:2b',
  );
});

test('a message that got no reply (stopped or failed) is marked, so it is not answered later', () => {
  const turns = toTurns([
    msg('user', 'Describe every column'),
    msg('user', 'How many orders?'),
  ]);
  assert.deepEqual(turns, [
    { role: 'user', text: 'Describe every column' },
    { role: 'assistant', text: NO_REPLY },
    { role: 'user', text: 'How many orders?' },
  ]);
  // The latest message, still waiting for its reply, isn't marked.
  assert.deepEqual(toTurns([msg('user', 'Hi')]), [
    { role: 'user', text: 'Hi' },
  ]);
});

test('a change asks for approval first; a "no" goes back to the model and nothing runs', async () => {
  const { provider, requests } = scripted(
    {
      toolCalls: [
        { id: 'a', name: 'look', input: {} },
        { id: 'b', name: 'edit', input: { page: 'x' } },
      ],
      stop: 'tools',
    },
    { text: 'OK, I left it.' },
  );
  let edited = false;
  const asked: string[] = [];
  const { saved } = await run(
    provider,
    [
      tool('look', async () => 'seen'),
      {
        ...tool('edit', async () => {
          edited = true;
        }),
        change: true,
      },
    ],
    {
      approve: async (call, summary) => {
        asked.push(`${call.name}: ${summary}`);
        return false;
      },
    },
  );
  assert.deepEqual(
    asked,
    ['edit: Doing edit'],
    'only the change is asked about',
  );
  assert.equal(edited, false);
  assert.deepEqual(saved[2], {
    role: 'tool',
    toolCallId: 'b',
    name: 'edit',
    content: NOT_ALLOWED,
  });
  assert.equal(requests[1].turns.at(-1)?.role, 'tool');
});

test('an approved change runs', async () => {
  const { provider } = scripted(
    { toolCalls: [{ id: 'b', name: 'edit', input: {} }], stop: 'tools' },
    { text: 'Done.' },
  );
  let edited = false;
  await run(
    provider,
    [
      {
        ...tool('edit', async () => {
          edited = true;
          return 'ok';
        }),
        change: true,
      },
    ],
    {
      approve: async () => true,
    },
  );
  assert.equal(edited, true);
});

test('stopping while waiting for approval stops the reply', async () => {
  const controller = new AbortController();
  const { provider } = scripted({
    toolCalls: [{ id: 'b', name: 'edit', input: {} }],
    stop: 'tools',
  });
  let edited = false;
  const { end } = await run(
    provider,
    [
      {
        ...tool('edit', async () => {
          edited = true;
        }),
        change: true,
      },
    ],
    {
      signal: controller.signal,
      approve: async () => {
        controller.abort();
        return false;
      },
    },
  );
  assert.equal(end, 'stopped');
  assert.equal(edited, false);
});

test('a tool can insist on being asked, and the loop says so', async () => {
  const { provider } = scripted(
    {
      toolCalls: [
        { id: 'a', name: 'rename', input: {} },
        { id: 'b', name: 'reconnect', input: { host: 'x' } },
        { id: 'c', name: 'unsure', input: {} },
      ],
      stop: 'tools',
    },
    { text: 'Done.' },
  );
  const asked: string[] = [];
  await run(
    provider,
    [
      { ...tool('rename', async () => 'ok'), change: true },
      {
        ...tool('reconnect', async () => 'ok'),
        change: true,
        alwaysAsk: (input) => 'host' in input,
      },
      {
        ...tool('unsure', async () => 'ok'),
        change: true,
        alwaysAsk: async () => {
          throw new Error('no such source');
        },
      },
    ],
    {
      approve: async (call, _summary, always) => {
        asked.push(`${call.name}: ${always}`);
        return true;
      },
    },
  );
  assert.deepEqual(asked, ['rename: false', 'reconnect: true', 'unsure: true']);
});

test("a change whose input is wrong isn't asked about: the model gets the error", async () => {
  const { provider, requests } = scripted(
    {
      toolCalls: [{ id: 'a', name: 'add', input: { password: 'x' } }],
      stop: 'tools',
    },
    { text: 'Sorry.' },
  );
  let asked = false;
  let ran = false;
  const { saved } = await run(
    provider,
    [
      {
        ...tool('add', async () => {
          ran = true;
        }),
        change: true,
        describe: () => {
          throw new Error('Passwords go in the form.');
        },
      },
    ],
    {
      approve: async () => {
        asked = true;
        return true;
      },
    },
  );
  assert.equal(asked, false);
  assert.equal(ran, false);
  assert.deepEqual(saved[1], {
    role: 'tool',
    toolCallId: 'a',
    name: 'add',
    content: 'Passwords go in the form.',
    isError: true,
  });
  assert.equal(requests.length, 2);
});

test('Stop reaches a running tool through its signal', async () => {
  const controller = new AbortController();
  const { provider } = scripted({
    toolCalls: [{ id: 'a', name: 'load', input: {} }],
    stop: 'tools',
  });
  let stoppedInside = false;
  const { end, saved } = await run(
    provider,
    [
      tool('load', (_input, _call, signal) => {
        controller.abort(); // the user presses Stop while it runs
        stoppedInside = signal?.aborted === true;
        return Promise.reject(new Error('Stopped.'));
      }),
    ],
    { signal: controller.signal },
  );
  assert.equal(stoppedInside, true);
  assert.equal(end, 'stopped');
  assert.deepEqual(saved.at(-1), {
    role: 'tool',
    toolCallId: 'a',
    name: 'load',
    content: 'Stopped.',
    isError: true,
  });
});
