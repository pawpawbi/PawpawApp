// The open project's errors: what failed and is still failing, as recorded in the project
// (a source's last load, in-place transforms, transformed tables, datasets). Shown behind the
// warning icon in the top bar and on the Errors page; wording in shared/project-errors.ts.
import { ipcMain } from 'electron';
import { listTransformed, readAllSources, readTransforms } from './data';
import { listDatasets } from './report';
import type { ProjectError } from './shared/types';

/** Every recorded error, in workflow order. A part that can't be read is left out. */
export async function listProjectErrors(): Promise<ProjectError[]> {
  const [sources, transforms, transformed, datasets] = await Promise.all([
    readAllSources().catch(() => []),
    readTransforms().catch(() => ({ tables: {} })),
    listTransformed().catch(() => []),
    listDatasets().catch(() => []),
  ]);
  const errors: ProjectError[] = [];
  for (const s of sources) {
    if (s.error)
      errors.push({ kind: 'source', name: s.name, message: s.error });
  }
  for (const [table, t] of Object.entries(transforms.tables).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (t.error)
      errors.push({ kind: 'transform', name: table, message: t.error });
  }
  for (const t of [...transformed].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (t.error)
      errors.push({ kind: 'transformed', name: t.name, message: t.error });
  }
  for (const d of datasets) {
    if (d.error)
      errors.push({ kind: 'dataset', name: d.name, message: d.error });
  }
  return errors;
}

export function registerProjectErrorHandlers() {
  ipcMain.handle('projects:errors', () => listProjectErrors());
}
