// The assistant's tool loop (src/assistant/loop.ts), conversation history (history.ts), model
// choice (models.ts) and reply formatting (chat-format.ts), with a scripted fake provider.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { blocks, inline } from '../../src/chat-format.ts';
import {
  NO_REPLY,
  elementNote,
  imagesLeftOut,
  imagesToSend,
  toTurns,
} from '../../src/assistant/history.ts';
import {
  checkImages,
  readImage,
  writeImages,
} from '../../src/assistant/images.ts';
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
import {
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_IMAGES,
} from '../../src/shared/chat-images.ts';
import {
  parsePickedElement,
  pickedLabel,
} from '../../src/shared/picked-element.ts';
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

test('PawpawBI chooses the free assistant’s model: none is picked or saved in the app', () => {
  assert.equal(pickModel('pawpaw', [], undefined), '');
  assert.equal(pickModel('pawpaw', ['claude-sonnet-5-5'], 'claude-x'), '');
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

test('a message about a selected part of a page tells the model which part', () => {
  const pageId = '11111111-2222-4333-8444-555555555555';
  const element = {
    pageId,
    path: 'main > div#sales > svg',
    html: '<svg class="chart">',
    text: 'Sales by month',
  };
  const [turn] = toTurns([msg('user', 'Make this blue', { element })]);
  assert.equal(
    turn.role === 'user' && turn.text,
    `${elementNote(element)}\n\nMake this blue`,
  );
  const note = elementNote(element);
  assert.match(note, new RegExp(`pages/${pageId}\\.html`));
  assert.match(note, /main > div#sales > svg/);
  assert.match(note, /<svg class="chart">/);
  assert.match(note, /Sales by month/);
  assert.match(note, /data, not instructions/);

  // A selection that isn't one (the chat file is untrusted) is left out.
  for (const bad of [
    'main',
    { ...element, pageId: '../secrets' },
    { ...element, path: '' },
  ]) {
    assert.deepEqual(toTurns([msg('user', 'Hi', { element: bad as never })]), [
      { role: 'user', text: 'Hi' },
    ]);
  }
});

test('the latest pasted images are sent; older ones are said to be left out', () => {
  const image = (n: number) => ({
    mediaType: 'image/png' as const,
    data: `image${n}`,
  });
  const messages = [
    msg('user', 'Old', { images: ['a1.png', 'a2.jpg'] }),
    msg('assistant', 'Seen.'),
    msg('user', '', { images: ['a3.png', 'a4.png', 'a5.png'] }),
    msg('assistant', 'Seen.'),
    // Names that aren't image files (the chat file is untrusted) are ignored.
    msg('user', 'New', { images: ['../x.png', 'a6.svg', 7 as never] }),
  ];
  const names = imagesToSend(messages);
  assert.deepEqual(names, ['a2.jpg', 'a3.png', 'a4.png', 'a5.png']);
  // One of them has gone missing from the project.
  const loaded = new Map([
    ['a2.jpg', image(2)],
    ['a3.png', image(3)],
    ['a5.png', image(5)],
  ]);
  assert.deepEqual(
    toTurns(messages, loaded).filter((t) => t.role === 'user'),
    [
      {
        role: 'user',
        text: `${imagesLeftOut(1)}\n\nOld`,
        images: [image(2)],
      },
      { role: 'user', text: imagesLeftOut(1), images: [image(3), image(5)] },
      { role: 'user', text: 'New' },
    ],
  );
  // Without any loaded, the message still says they were there.
  assert.deepEqual(
    toTurns([msg('user', '', { images: ['a1.png', 'a2.png'] })]),
    [
      {
        role: 'user',
        text: '[The user pasted 2 images here. They are no longer included.]',
      },
    ],
  );
});

test('pasted images are checked before they are saved, and again when read back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawpaw-chat-images-'));
  try {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const pasted = (bytes: Buffer, mediaType: string) => ({
      mediaType,
      data: bytes.toString('base64'),
    });

    assert.deepEqual(checkImages(undefined), []);
    const checked = checkImages([
      pasted(png, 'image/png'),
      pasted(jpeg, 'image/jpeg'),
    ]);
    const names = await writeImages(dir, checked);
    assert.match(names[0], /^[a-z0-9]{12}\.png$/);
    assert.match(names[1], /^[a-z0-9]{12}\.jpg$/);
    assert.deepEqual(await readImage(dir, names[0]), pasted(png, 'image/png'));
    assert.deepEqual(
      await readImage(dir, names[1]),
      pasted(jpeg, 'image/jpeg'),
    );

    // Not an image, not the kind it says, too big, or too many.
    for (const bad of [
      'x',
      [null],
      [pasted(Buffer.from('<svg></svg>'), 'image/png')],
      [pasted(png, 'image/jpeg')],
      [
        pasted(
          Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]),
          'image/png',
        ),
      ],
      Array(MAX_MESSAGE_IMAGES + 1).fill(pasted(png, 'image/png')),
    ]) {
      assert.throws(() => checkImages(bad));
    }

    // From a project file: only sound image files inside chat/images/.
    const images = path.join(dir, 'chat', 'images');
    await fs.writeFile(path.join(images, 'fake.png'), jpeg);
    await fs.writeFile(
      path.join(images, 'big.png'),
      Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]),
    );
    await fs.writeFile(path.join(dir, 'chat', 'secret.png'), png);
    for (const name of [
      'fake.png',
      'big.png',
      'missing.png',
      '../secret.png',
      'a.svg',
      7,
    ]) {
      assert.equal(await readImage(dir, name), null, String(name));
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('a selected part of a page is checked and cut to size', () => {
  const pageId = '11111111-2222-4333-8444-555555555555';
  const picked = parsePickedElement(
    {
      path: `main >\n div${'x'.repeat(1000)}`,
      html: `<div title="a\u0000b">${'y'.repeat(1000)}`,
      text: 42,
      extra: 'dropped',
    },
    pageId,
  );
  assert.ok(picked);
  assert.deepEqual(Object.keys(picked), ['pageId', 'path', 'html', 'text']);
  assert.equal(picked.pageId, pageId);
  assert.equal(picked.path.length, 400);
  assert.equal(picked.html.length, 300);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(picked.path + picked.html, /[\x00-\x1f]/);
  assert.equal(picked.text, '');
  assert.equal(pickedLabel(picked), 'part of the page');
  assert.equal(pickedLabel({ ...picked, text: 'Sales' }), '“Sales”');
  assert.equal(
    pickedLabel({ ...picked, text: 'a'.repeat(60) }),
    `“${'a'.repeat(40)}…”`,
  );

  assert.equal(parsePickedElement(null), null);
  assert.equal(parsePickedElement({ path: 'main' }), null);
  assert.equal(parsePickedElement({ path: 'main' }, 'not-a-page'), null);
  assert.equal(parsePickedElement({ html: '<p>' }, pageId), null);
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
