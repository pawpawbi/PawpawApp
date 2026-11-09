// A project being refreshed in the background (src/scheduled-refresh.ts), apart from the one
// open in the window. Code run inside withBackgroundProject sees it as "the open project":
// openProject() and markProjectChanged() in projects.ts, callPython() (its own Python sidecar)
// and the progress messages of data.ts and published.ts all follow it, so loading, rebuilding
// and uploading work on it unchanged while the window keeps its own project.
//
// No Electron imports.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PublishProgress } from './shared/types';
import type { Workspace } from './workspace';

export interface BackgroundProject {
  workspace: Workspace;
  /** What it's doing, e.g. "Sales (1 of 3): loading…". */
  onMessage: (message: string) => void;
  /** How the upload is going. */
  onUpload: (progress: PublishProgress) => void;
}

const current = new AsyncLocalStorage<BackgroundProject>();

/** The background project the calling code runs for, if any. */
export const backgroundProject = () => current.getStore();

/** Runs `work` with `project` as the open project (see above). */
export const withBackgroundProject = <T>(
  project: BackgroundProject,
  work: () => Promise<T>,
) => current.run(project, work);
