// Running one reply: the tool loop (loop.ts) against the chosen provider, with the project's
// state as context, approval of each change, and every step saved to the chat
// (chat/messages.jsonl) as it happens. Calls to the providers go out from here with Node's
// fetch, so they don't pass through the app windows' network lockdown (report.ts).
import type { IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { work } from '../background';
import { readAllSources } from '../data';
import {
  appendChatMessages,
  loadChat,
  markProjectChanged,
  openProject,
  tracked,
} from '../projects';
import { callPython } from '../python';
import { listDatasets } from '../report';
import { hasSite, readReport } from '../report-site';
import type {
  ApprovalAnswer,
  AssistantChange,
  AssistantEnd,
  AssistantProvider,
  ChatMessage,
  TableSchema,
  WorkflowStage,
} from '../shared/types';
import { INTRO_MESSAGE, STAGES } from '../workflow';
import { claim, emitter, message } from './chat';
import { toTurns } from './history';
import { NOT_ALLOWED, runAssistant } from './loop';
import { modelTools } from './model-tools';
import { SYSTEM_PROMPT, projectContext } from './prompt';
import { providerFor } from './providers';
import { reportTools } from './report-tools';
import { getSettings, setPermissions } from './settings';
import { sourceTools } from './source-tools';
import { READ_TOOLS } from './tools';
import type { ToolContext, ToolSpec } from './types';
import { journal } from './undo';

/** The project as it is now, for the request's context. Anything unavailable is left out. */
async function snapshot(stage: WorkflowStage) {
  const project = openProject();
  const [sources, tables, report] = await Promise.all([
    readAllSources().catch(() => []),
    callPython<TableSchema[]>('describe_tables', {
      data_dir: path.join(project.filesDir, 'data'),
    }).catch(() => []),
    (async () => {
      if (!(await hasSite(project.filesDir))) return null;
      const site = await readReport(project.filesDir);
      const datasets = await listDatasets().catch(() => []);
      return {
        pages: site.pages.map((p) => `${p.title} (pages/${p.id}.html)`),
        datasets: datasets.map((d) => ({
          name: d.name,
          ...(d.error ? { error: d.error } : {}),
        })),
      };
    })().catch(() => null),
  ]);
  return projectContext({
    name: project.name,
    step: STAGES.find((s) => s.id === stage)?.label ?? stage,
    sources: sources.map((s) => ({
      name: s.name,
      type: s.type,
      tables: s.tables,
      lastLoadedAt: s.lastLoadedAt,
    })),
    tables: tables.map((t) => ({ name: t.name, kind: t.kind, rows: t.rows })),
    report,
  });
}

/**
 * The tools offered: everything for Claude and ChatGPT. Small local models (Ollama) get the
 * read tools and only the change tools for the step the user is on, so they have fewer to
 * choose from.
 */
export function toolsFor(
  provider: AssistantProvider,
  stage: WorkflowStage,
  ctx: ToolContext,
): ToolSpec[] {
  const byStage: Record<WorkflowStage, ToolSpec[]> = {
    data: sourceTools(ctx),
    model: modelTools(ctx),
    visuals: reportTools(ctx),
  };
  return provider === 'ollama'
    ? [...READ_TOOLS, ...byStage[stage]]
    : [...READ_TOOLS, ...Object.values(byStage).flat()];
}

/** A tool's name as a fallback label, e.g. "Add source" for add_source. */
const toolLabel = (name: string) =>
  name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');

/** Approval requests waiting for the user's answer, by tool call ID. */
const waiting = new Map<string, (answer: ApprovalAnswer) => void>();

export function answer(id: string, choice: ApprovalAnswer) {
  waiting.get(id)?.(
    ['allow', 'allow-all', 'deny'].includes(choice) ? choice : 'deny',
  );
}

let running: AbortController | null = null;

export const stop = () => running?.abort();

/**
 * Runs a reply. With text, it's a new message from the user; with null, it tries the last
 * reply again (after an error), continuing from the conversation as saved.
 */
export async function reply(
  event: IpcMainInvokeEvent,
  text: string | null,
): Promise<AssistantEnd> {
  if (text !== null && (typeof text !== 'string' || !text.trim())) {
    throw new Error('Type a message first.');
  }
  const release = claim('reply');
  const controller = new AbortController();
  running = controller;
  try {
    const settings = await getSettings();
    const provider = await providerFor(settings.provider);
    const model = settings.models[settings.provider];
    if (!model) throw new Error('Choose a model in Assistant settings first.');
    const emit = emitter(event);

    return await tracked('The assistant is replying', async () => {
      const stopOnCancel = work.onCancel(() => controller.abort());
      try {
        const chat = await loadChat();
        const added: ChatMessage[] = [];
        // The welcome message is saved with the first reply, like the chat panel shows it.
        if (text !== null) {
          if (!chat.messages.length) {
            added.push(message({ role: 'assistant', text: INTRO_MESSAGE }));
          }
          added.push(message({ role: 'user', text: text.trim() }));
        } else if (!chat.messages.some((m) => m.role === 'user')) {
          throw new Error("There's nothing to try again.");
        }
        await appendChatMessages(added);
        for (const m of added) emit({ type: 'message', message: m });

        // What each tool call is for, as the chat shows it, and the change it made (if any).
        const summaries = new Map<string, string>();
        const made = new Map<string, AssistantChange>();
        const ctx: ToolContext = {
          change: async (
            call,
            summary,
            targets,
            operation,
            areas = ['report'],
          ) => {
            const { result, record } = await journal().record(
              summary,
              targets,
              operation,
            );
            made.set(call.id, record);
            await markProjectChanged();
            emit({ type: 'changed', areas });
            return result;
          },
          changed: async (areas) => {
            await markProjectChanged();
            emit({ type: 'changed', areas });
          },
          show: (stage, pageId) => emit({ type: 'show', stage, pageId }),
        };
        const approve = async (
          call: { id: string },
          summary: string,
          always: boolean,
          permanent: boolean,
        ) => {
          summaries.set(call.id, summary);
          if (!always && (await getSettings()).permissions === 'allow')
            return true;
          const onAbort = () => answer(call.id, 'deny');
          const choice = await new Promise<ApprovalAnswer>((resolve) => {
            waiting.set(call.id, resolve);
            controller.signal.addEventListener('abort', onAbort);
            emit({
              type: 'approval',
              id: call.id,
              summary,
              ...(always ? { always: true } : {}),
              ...(permanent ? { permanent: true } : {}),
            });
          });
          controller.signal.removeEventListener('abort', onAbort);
          waiting.delete(call.id);
          // "Allow all" doesn't cover changes that are always asked about.
          if (choice === 'allow-all' && !always) await setPermissions('allow');
          return choice !== 'deny';
        };

        return await runAssistant({
          provider,
          model,
          system: SYSTEM_PROMPT,
          context: await snapshot(chat.stage),
          tools: toolsFor(settings.provider, chat.stage, ctx),
          approve,
          history: toTurns([...chat.messages, ...added]),
          signal: controller.signal,
          onText: (t) => emit({ type: 'text', text: t }),
          onToolStart: (call, summary) => {
            summaries.set(call.id, summary);
            emit({ type: 'tool', id: call.id, summary, status: 'running' });
          },
          onToolEnd: (call, ok) =>
            emit({
              type: 'tool',
              id: call.id,
              summary: summaries.get(call.id) ?? call.name,
              status: ok ? 'done' : 'failed',
            }),
          onTurn: async (turn) => {
            const saved =
              turn.role === 'tool'
                ? message({
                    role: 'tool',
                    text: turn.content,
                    toolCallId: turn.toolCallId,
                    toolName: turn.name,
                    summary:
                      turn.content === NOT_ALLOWED
                        ? `Not allowed: ${summaries.get(turn.toolCallId) ?? toolLabel(turn.name)}`
                        : (made.get(turn.toolCallId)?.summary ??
                          summaries.get(turn.toolCallId) ??
                          toolLabel(turn.name)),
                    ...(turn.content === NOT_ALLOWED ? { declined: true } : {}),
                    ...(made.has(turn.toolCallId)
                      ? { changeId: made.get(turn.toolCallId)!.id }
                      : {}),
                    ...(turn.isError ? { isError: true } : {}),
                  })
                : message({
                    role: 'assistant',
                    text: turn.text,
                    ...(turn.toolCalls?.length
                      ? { toolCalls: turn.toolCalls }
                      : {}),
                  });
            await appendChatMessages([saved]);
            emit({ type: 'message', message: saved });
          },
        });
      } finally {
        stopOnCancel();
      }
    });
  } finally {
    running = null;
    release();
  }
}
