// One reply from the assistant: call the model, run the tools it asks for, give it the
// results, and repeat until it answers (or a step limit is reached). Provider-neutral, and no
// Electron imports, so it's tested with a fake provider (tests/node/assistant-loop.test.ts).
import type { AssistantEnd } from '../shared/types';
import type { ModelRequest, Provider, ToolCall, ToolSpec, Turn } from './types';

/** A turn the loop produces: the model's reply, or a tool's result. */
export type ReplyTurn = Exclude<Turn, { role: 'user' }>;

/** Tool results longer than this are cut, so one big result can't swamp the conversation. */
export const MAX_RESULT_CHARS = 20_000;

export interface LoopOptions {
  provider: Provider;
  model: string;
  system: string;
  context: string;
  tools: ToolSpec[];
  /** The conversation so far, ending with the user's new message. */
  history: Turn[];
  signal: AbortSignal;
  maxSteps?: number;
  maxTokens?: number;
  onText?: (text: string) => void;
  onToolStart?: (call: ToolCall, summary: string) => void;
  onToolEnd?: (call: ToolCall, ok: boolean) => void;
  /**
   * Asked before a tool that changes the project runs. Resolves true to go ahead. `always` is
   * true when the user must be asked even if they've chosen not to be (the tool's `alwaysAsk`);
   * `permanent` when the change can't be undone. Without it, changes run without asking.
   */
  approve?: (
    call: ToolCall,
    summary: string,
    always: boolean,
    permanent: boolean,
  ) => Promise<boolean>;
  /** Each new turn (the model's replies and tool results), to save it. */
  onTurn: (turn: ReplyTurn) => Promise<void> | void;
}

/** The tool result when the user doesn't allow a change. */
export const NOT_ALLOWED =
  "The user didn't allow this change, so it wasn't made. Don't try it again unless they ask; ask what they'd like instead.";

/** A tool's result as text for the model. */
export function resultText(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : (JSON.stringify(value ?? null) ?? 'null');
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n[Cut short: the full result was ${text.length.toLocaleString('en')} characters. Ask for less, e.g. fewer rows or columns.]`
    : text;
}

const isAbort = (error: unknown) =>
  (error as Error)?.name === 'AbortError' ||
  (error as Error)?.name === 'TimeoutError';

export async function runAssistant(
  options: LoopOptions,
): Promise<AssistantEnd> {
  const { provider, signal, onTurn } = options;
  const tools = new Map(options.tools.map((t) => [t.name, t]));
  const turns: Turn[] = [...options.history];
  const save = async (turn: ReplyTurn) => {
    turns.push(turn);
    await onTurn(turn);
  };

  for (let step = 0; step < (options.maxSteps ?? 12); step++) {
    const request: ModelRequest = {
      model: options.model,
      system: options.system,
      context: options.context,
      turns,
      tools: options.tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
      maxTokens: options.maxTokens ?? 8192,
    };
    let partial = '';
    let response;
    try {
      response = await provider.complete(
        request,
        (text) => {
          partial += text;
          options.onText?.(text);
        },
        signal,
      );
    } catch (error) {
      if (!isAbort(error) && !signal.aborted) throw error;
      // Stopped: keep what had been written so far.
      if (partial) await save({ role: 'assistant', text: partial });
      return 'stopped';
    }

    const calls = response.toolCalls;
    if (response.text || calls.length) {
      await save({
        role: 'assistant',
        text: response.text,
        ...(calls.length ? { toolCalls: calls } : {}),
      });
    }
    if (response.stop !== 'tools' || !calls.length)
      return response.stop === 'tools' ? 'end' : response.stop;

    for (const call of calls) {
      if (signal.aborted) return 'stopped';
      const tool = tools.get(call.name);
      let summary = call.name;
      try {
        summary = (await tool?.describe(call.input)) ?? call.name;
      } catch (error) {
        // A change that can't even be described (its input is wrong) isn't asked about: the
        // model gets the error to fix. Anything else keeps the tool's name.
        if (tool?.change) {
          await save({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: (error as Error)?.message || String(error),
            isError: true,
          });
          continue;
        }
      }
      if (tool?.change && options.approve) {
        let always = false;
        try {
          always = Boolean(await tool.alwaysAsk?.(call.input));
        } catch {
          always = true; // If it can't tell, ask.
        }
        const allowed = await options.approve(
          call,
          summary,
          always,
          tool.permanent === true,
        );
        if (signal.aborted) return 'stopped';
        if (!allowed) {
          await save({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: NOT_ALLOWED,
          });
          continue;
        }
      }
      options.onToolStart?.(call, summary);
      let content: string;
      let ok = true;
      try {
        if (!tool) throw new Error(`There's no tool called ${call.name}.`);
        content = resultText(await tool.run(call.input, call, signal));
      } catch (error) {
        ok = false;
        content = (error as Error)?.message || String(error);
      }
      await save({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content,
        ...(ok ? {} : { isError: true }),
      });
      options.onToolEnd?.(call, ok);
    }
  }
  return 'steps';
}
