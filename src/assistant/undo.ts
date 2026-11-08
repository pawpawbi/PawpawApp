// Undoing the assistant's changes: the project's change journal, and the undo itself.
import type { IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { rebuildDerived, removeUnaccountedData, sourceTables } from '../data';
import {
  appendChatMessages,
  markProjectChanged,
  openProject,
  tracked,
} from '../projects';
import { refreshDatasets } from '../report';
import type { AssistantChange } from '../shared/types';
import { ChangeJournal } from './changes';
import { claim, emitter, message } from './chat';

/** The report's data: rewritten whenever tables change, so never an edit to warn about. */
const REBUILT = /^report\/data\//;

/** Files that, put back, mean the data must be rebuilt to match: sources, SQL, loaded data. */
const DATA_FILES =
  /^(sources\/|data\/|model\/transforms\.json$|model\/transformed\.json$)/;

/**
 * The open project's change journal. Its store is in the working folder, beside the files, and
 * goes when the project is closed, so the journal is opened afresh each time rather than kept:
 * a kept one would still list changes whose copies are gone.
 */
export const journal = () =>
  new ChangeJournal(
    openProject().filesDir,
    path.join(path.dirname(openProject().filesDir), 'assistant-changes'),
    { rebuilt: (file) => REBUILT.test(file) },
  );

/**
 * Puts the files back for `undoBackTo(id)`, then brings the data in line with them: removes data
 * nothing accounts for any more and rebuilds what's built from the SQL (or, if only datasets
 * changed, rewrites the report's data).
 */
async function undoFiles(id: string) {
  const changes = journal();
  const files = await changes.files(id);
  const before = await sourceTables();
  const undone = await changes.undoBackTo(id);
  if (files.some((f) => DATA_FILES.test(f))) {
    await removeUnaccountedData(before);
    await rebuildDerived();
  } else if (files.includes('model/datasets.json')) {
    await refreshDatasets();
  }
  return undone;
}

/**
 * Undoes a change and every later one (asking first, through `conflicts`, if any of their files
 * were edited since), then tells the assistant, so it knows those changes are gone.
 */
export async function undo(
  event: IpcMainInvokeEvent,
  id: string,
  force = false,
): Promise<{ undone: AssistantChange[]; conflicts: string[] }> {
  const release = claim('undo');
  try {
    return await tracked('Undoing the assistant’s changes', async () => {
      const conflicts = await journal().conflicts(id);
      if (conflicts.length && !force) return { undone: [], conflicts };
      const undone = await undoFiles(id);
      await markProjectChanged();
      const summaries = undone.map((c) => c.summary).join('; ');
      const note = message({
        role: 'user',
        event: true,
        summary: `Undid: ${summaries}`,
        text: `[I undid your ${undone.length === 1 ? 'change' : 'changes'}: ${summaries}. They're no longer in the project.]`,
      });
      await appendChatMessages([note]);
      const emit = emitter(event);
      emit({ type: 'message', message: note });
      emit({ type: 'changed', areas: ['sources', 'model', 'report'] });
      return { undone, conflicts: [] };
    });
  } finally {
    release();
  }
}
