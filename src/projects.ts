// Main-process handling of .pawpaw project files, the open project's working folder and the
// recent projects list. File format and open/save behaviour: docs/pawpaw-file-format.md
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deleteProjectSecrets } from './credentials';
import { readJson, writeJson } from './fs-json';
import { InvalidProjectFileError } from './pawpaw-archive';
import { work } from './background';
import { stopPython } from './python';
import { createSite } from './report-site';
import { SITE_TEMPLATES } from './report-templates';
import { MAX_PROJECT_NAME } from './shared/ids';
import type {
  ChatMessage,
  ChatState,
  OpenResult,
  Project,
  RecentProject,
  WorkflowStage,
} from './shared/types';
import {
  createWorkspace,
  markWorkspaceDirty,
  openWorkspace,
  removeWorkspace,
  renameWorkspace,
  saveWorkspace,
  type Workspace,
  type WorkspaceOptions,
  type WorkspaceState,
} from './workspace';
import { STAGES } from './workflow';

const PROJECT_EXTENSION = 'pawpaw';
const PROJECT_FILTERS = [
  { name: 'PawpawBI project', extensions: [PROJECT_EXTENSION] },
];
const MAX_RECENTS = 10;
const WORKFLOW_STAGES = STAGES.map((s) => s.id);

// ---------------------------------------------------------------------------------------------
// Recent projects

const recentsPath = () =>
  path.join(app.getPath('userData'), 'recent-projects.json');

export const readRecents = () =>
  readJson(recentsPath(), (raw): RecentProject[] =>
    Array.isArray(raw)
      ? raw.filter(
          (r) => typeof r?.path === 'string' && typeof r?.name === 'string',
        )
      : [],
  );

const writeRecents = (recents: RecentProject[]) =>
  writeJson(recentsPath(), recents);

async function addRecent(name: string, filePath: string) {
  const recents = (await readRecents()).filter((r) => r.path !== filePath);
  recents.unshift({ name, path: filePath, openedAt: new Date().toISOString() });
  await writeRecents(recents.slice(0, MAX_RECENTS));
}

async function removeRecent(filePath: string) {
  await writeRecents((await readRecents()).filter((r) => r.path !== filePath));
}

// ---------------------------------------------------------------------------------------------
// The open project. Its working folder and crash recovery are in workspace.ts; this module adds
// the dialogs, the recent list, window updates and IPC.

let session: Workspace | null = null;

const appLabel = () => `PawpawBI ${app.getVersion()}`;

const workspaceOptions = (): WorkspaceOptions => ({
  root: path.join(app.getPath('userData'), 'workspaces'),
  appLabel: appLabel(),
});

function requireSession(): Workspace {
  if (!session) throw new Error('No project is open.');
  return session;
}

function toProject(s: Workspace): Project {
  return {
    id: s.manifest.id,
    name: s.manifest.name,
    path: s.filePath,
    dirty: s.dirty,
    busy: work.running(s.manifest.id).length > 0,
  };
}

// The renderer shows when background work is running (and Save waits for it).
work.onChange(() => notifyChanged());

/** Updates window titles and tells the renderer the project changed. */
function notifyChanged() {
  for (const win of BrowserWindow.getAllWindows()) {
    win.setTitle(
      session
        ? `${session.manifest.name}${session.dirty ? ' •' : ''} - PawpawBI`
        : 'PawpawBI',
    );
    if (process.platform === 'darwin')
      win.setDocumentEdited(session?.dirty ?? false);
    if (session) win.webContents.send('project:changed', toProject(session));
  }
}

/** Records that the open project has changed since it was last saved. */
export async function markProjectChanged() {
  if (await markWorkspaceDirty(requireSession())) notifyChanged();
}

/**
 * Runs an operation that changes the open project as tracked background work, so saving waits
 * for it and closing waits for it or stops it (see background.ts).
 */
export const tracked = <R>(
  label: string,
  operation: () => Promise<R>,
  key?: string,
) => work.run(openProject().id, label, operation, key);

async function askToRecover(
  win: BrowserWindow,
  name: string,
  state: WorkspaceState,
) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Recover', 'Discard'],
    defaultId: 0,
    cancelId: 1,
    title: 'Recover unsaved changes',
    message: `"${name}" has unsaved changes from ${new Date(state.updatedAt).toLocaleString()}.`,
    detail:
      'PawpawBI closed before they were saved. Recover them, or discard them and open the last saved version?',
  });
  return response === 0;
}

/** Called after a project is opened in a window (e.g. to list it if it's published). */
const openedListeners = new Set<() => Promise<void>>();

export const onProjectOpened = (listener: () => Promise<void>) => {
  openedListeners.add(listener);
};

async function openProjectFile(
  filePath: string,
  win: BrowserWindow,
): Promise<Project> {
  if (session) throw new Error('Close the open project first.');

  session = await openWorkspace(filePath, {
    ...workspaceOptions(),
    askToRecover: (name, state) => askToRecover(win, name, state),
  });
  await addRecent(session.manifest.name, filePath);
  notifyChanged();
  for (const listener of openedListeners) {
    await listener().catch((error) =>
      console.error('After opening the project:', error),
    );
  }
  return toProject(session);
}

/**
 * Opens a project without a window (refreshing a published report from the start screen). A
 * project with unsaved changes from a crash isn't opened, so they're never discarded unseen.
 */
export async function openProjectInBackground(filePath: string) {
  if (session) throw new Error('Close the open project first.');
  session = await openWorkspace(filePath, {
    ...workspaceOptions(),
    askToRecover: () => {
      throw new Error(
        'This project has unsaved changes from when PawpawBI closed unexpectedly. Open it to recover or discard them first.',
      );
    },
  });
  notifyChanged();
}

/** Closes the open project without saving or asking (after a background refresh). */
export async function closeProjectQuietly() {
  if (!session) return;
  const closed = session;
  session = null;
  await removeWorkspace(closed);
  notifyChanged();
}

async function createProject(win: BrowserWindow): Promise<Project | null> {
  if (session) throw new Error('Close the open project first.');

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Create project',
    buttonLabel: 'Create',
    defaultPath: path.join(
      app.getPath('documents'),
      `Untitled report.${PROJECT_EXTENSION}`,
    ),
    filters: PROJECT_FILTERS,
  });
  if (canceled || !filePath) return null;

  // New projects start with the default report, ready to build on.
  session = await createWorkspace(filePath, {
    ...workspaceOptions(),
    populate: (filesDir, name) => createSite(filesDir, name, SITE_TEMPLATES),
  });
  await addRecent(session.manifest.name, filePath);
  notifyChanged();
  return toProject(session);
}

export async function saveProject(): Promise<Project> {
  const s = requireSession();
  // Never zip a working folder that a load or rebuild is writing to, or could start writing to.
  work.block(s.manifest.id);
  try {
    await work.idle(s.manifest.id);
    await saveWorkspace(s, appLabel());
  } finally {
    work.unblock(s.manifest.id);
  }
  notifyChanged();
  return toProject(s);
}

/**
 * Waits for, or stops, the open project's background work before it's closed: closing deletes
 * the working folder that work writes to. False if the user chooses to keep working.
 */
async function finishBackgroundWork(win: BrowserWindow, projectId: string) {
  const running = [...new Set(work.running(projectId))];
  if (running.length === 0) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Wait', 'Stop and close', 'Keep working'],
    defaultId: 0,
    cancelId: 2,
    title: 'Still working',
    message:
      running.length === 1
        ? `${running[0]} is still in progress.`
        : `${running.join(', ')} are still in progress.`,
    detail:
      'Wait closes the project as soon as it finishes. Stop and close ends it now; tables it was loading or building may be incomplete, so refresh them next time.',
  });
  if (response === 2) return false;
  // Nothing new can start for this project from here on.
  work.block(projectId);
  try {
    if (response === 1) {
      work.cancel(projectId);
      // Also interrupts anything the Python sidecar is doing; it restarts on next use.
      stopPython();
    }
    await work.idle(projectId);
  } finally {
    work.unblock(projectId);
  }
  return true;
}

/** Closes the open project, asking to save unsaved changes first. False if the user cancels. */
// The window's close event and the Projects button can both ask to close; one close at a time.
let closing: Promise<boolean> | null = null;

export function closeProject(win: BrowserWindow): Promise<boolean> {
  closing ??= closeOpenProject(win).finally(() => {
    closing = null;
  });
  return closing;
}

async function closeOpenProject(win: BrowserWindow): Promise<boolean> {
  if (!session) return true;
  if (!(await finishBackgroundWork(win, session.manifest.id))) return false;
  if (!session) return true;
  if (session.dirty) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Save', "Don't save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved changes',
      message: `Save changes to "${session.manifest.name}"?`,
      detail: "Your changes will be lost if you don't save them.",
    });
    if (response === 2) return false;
    if (response === 0) await saveProject();
  }
  const closed = session;
  session = null;
  await removeWorkspace(closed);
  notifyChanged();
  return true;
}

/** Renames the open project. The new name is saved with the project, like any change. */
async function renameProject(name: unknown): Promise<Project> {
  const s = requireSession();
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) throw new Error('Enter a name for the project.');
  if (clean.length > MAX_PROJECT_NAME) {
    throw new Error(
      `Use a shorter name: at most ${MAX_PROJECT_NAME} characters.`,
    );
  }
  if (clean === s.manifest.name) return toProject(s);
  await renameWorkspace(s, clean);
  await writeRecents(
    (await readRecents()).map((r) =>
      r.path === s.filePath ? { ...r, name: clean } : r,
    ),
  );
  await markProjectChanged();
  notifyChanged();
  return toProject(s);
}

/**
 * Deletes the open project: its file goes to the Recycle Bin (if it was ever saved), it leaves
 * the recent list, its data sources' saved credentials are deleted and it's closed without
 * saving. False if the user chose to keep working while background work finishes.
 */
async function deleteProject(win: BrowserWindow): Promise<boolean> {
  const s = requireSession();
  if (!(await finishBackgroundWork(win, s.manifest.id))) return false;
  if (session !== s) return true;
  try {
    await fs.access(s.filePath);
    await shell.trashItem(s.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `Couldn't move the project file to the Recycle Bin. Close any program using it and try again. (${(error as Error).message})`,
      );
    }
  }
  await removeRecent(s.filePath);
  await deleteProjectSecrets(s.manifest.id);
  session = null;
  await removeWorkspace(s);
  notifyChanged();
  return true;
}

export const hasOpenProject = () => session !== null;

/** The open project's ID, name and working folder, for other modules that use its files. */
export function openProject(): {
  id: string;
  name: string;
  filesDir: string;
  /** The .pawpaw file. */
  filePath: string;
} {
  const s = requireSession();
  return {
    id: s.manifest.id,
    name: s.manifest.name,
    filesDir: s.filesDir,
    filePath: s.filePath,
  };
}

// ---------------------------------------------------------------------------------------------
// Chat (chat/session.json and chat/messages.jsonl)

export async function loadChat(): Promise<ChatState> {
  const chatDir = path.join(requireSession().filesDir, 'chat');

  let stage: WorkflowStage = 'data';
  try {
    const saved = JSON.parse(
      await fs.readFile(path.join(chatDir, 'session.json'), 'utf8'),
    );
    if (WORKFLOW_STAGES.includes(saved?.stage)) stage = saved.stage;
  } catch {
    // No saved session yet.
  }

  let lines: string[] = [];
  try {
    lines = (
      await fs.readFile(path.join(chatDir, 'messages.jsonl'), 'utf8')
    ).split('\n');
  } catch {
    // No messages yet.
  }
  const messages = lines.flatMap((line): ChatMessage[] => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return []; // Skip a damaged line rather than lose the whole conversation.
    }
  });
  return { stage, messages };
}

async function setStage(stage: WorkflowStage) {
  if (!WORKFLOW_STAGES.includes(stage))
    throw new Error(`Unknown workflow stage: ${stage}`);
  await writeJson(
    path.join(requireSession().filesDir, 'chat', 'session.json'),
    { stage },
  );
  await markProjectChanged();
}

/** Adds messages to the end of the conversation. */
export async function appendChatMessages(messages: ChatMessage[]) {
  const chatDir = path.join(requireSession().filesDir, 'chat');
  await fs.mkdir(chatDir, { recursive: true });
  await fs.appendFile(
    path.join(chatDir, 'messages.jsonl'),
    messages.map((m) => JSON.stringify(m) + '\n').join(''),
  );
  await markProjectChanged();
}

async function appendChat(messages: ChatMessage[], stage: WorkflowStage) {
  await appendChatMessages(messages);
  await setStage(stage);
}

// ---------------------------------------------------------------------------------------------
// IPC

const windowFor = (event: IpcMainInvokeEvent) =>
  BrowserWindow.fromWebContents(event.sender)!;

/** Turns failures into a message for the start screen instead of a rejected promise. */
async function toOpenResult(
  action: () => Promise<Project | null>,
): Promise<OpenResult> {
  try {
    const project = await action();
    return project && { project };
  } catch (error) {
    if (error instanceof InvalidProjectFileError)
      return { error: error.message };
    console.error(error);
    return { error: `Something went wrong: ${(error as Error).message}` };
  }
}

export function registerProjectHandlers() {
  ipcMain.handle('projects:list-recent', () => readRecents());

  ipcMain.handle('projects:create', (event) =>
    toOpenResult(() => createProject(windowFor(event))),
  );

  ipcMain.handle('projects:open', (event) =>
    toOpenResult(async () => {
      const win = windowFor(event);
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Open project',
        properties: ['openFile'],
        filters: PROJECT_FILTERS,
      });
      if (canceled || filePaths.length === 0) return null;
      return openProjectFile(filePaths[0], win);
    }),
  );

  ipcMain.handle('projects:open-recent', async (event, filePath: string) => {
    // Only reopen paths we handed out ourselves, not arbitrary files.
    const recent = (await readRecents()).find((r) => r.path === filePath);
    if (!recent)
      return { error: 'That project is no longer in your recent projects.' };
    try {
      await fs.access(filePath);
    } catch {
      await removeRecent(filePath);
      return {
        error: `"${recent.name}" couldn't be found, so it was removed from your recent projects.`,
      };
    }
    return toOpenResult(() => openProjectFile(filePath, windowFor(event)));
  });

  ipcMain.handle('projects:save', () => saveProject());
  ipcMain.handle('projects:close', (event) => closeProject(windowFor(event)));
  ipcMain.handle('projects:rename', (_event, name: string) =>
    tracked('Renaming the project', () => renameProject(name)),
  );
  ipcMain.handle('projects:delete', (event) => deleteProject(windowFor(event)));
  ipcMain.handle('projects:load-chat', () => loadChat());
  ipcMain.handle(
    'projects:append-chat',
    (_event, messages: ChatMessage[], stage: WorkflowStage) =>
      appendChat(messages, stage),
  );
  ipcMain.handle('projects:set-stage', (_event, stage: WorkflowStage) =>
    setStage(stage),
  );
}
