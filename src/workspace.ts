// The open project's working folder, and recovering unsaved changes after a crash.
// File format and open/save behaviour: docs/pawpaw-file-format.md
//
// An open project is extracted into a working folder, <root>/<id>-<path hash>/:
//   project/     the archive's contents, which everything reads and writes
//   state.json   which file it came from and whether it has unsaved changes
// The folder is deleted when the project is closed. If the app crashes it survives, and its
// unsaved changes are offered back the next time that file is opened.
//
// No Electron imports: projects.ts passes in the app's data folder, version and a function that
// asks the user, so this is tested with plain Node (tests/node/workspace.test.ts).
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, removePath, writeJson } from './fs-json';
import {
  InvalidProjectFileError,
  extractArchive,
  isZipFile,
  packArchive,
  readArchiveEntry,
} from './pawpaw-archive';
import { SAFE_ID, newId } from './shared/ids';
import type { ProjectManifest } from './shared/types';

export const FORMAT_VERSION = 1;

/** An open project's working folder. */
export interface Workspace {
  manifest: ProjectManifest;
  filePath: string;
  workspaceDir: string;
  filesDir: string;
  /** True when there are changes not yet saved to the .pawpaw file. */
  dirty: boolean;
}

/** state.json in a working folder. */
export interface WorkspaceState {
  filePath: string;
  dirty: boolean;
  updatedAt: string;
}

export interface WorkspaceOptions {
  /** The folder holding working folders, e.g. userData/workspaces. */
  root: string;
  /** Recorded in manifests as createdWith/modifiedWith, e.g. "PawpawBI 1.0.0". */
  appLabel: string;
}

export interface CreateOptions extends WorkspaceOptions {
  /** Writes a new project's starting files (e.g. the default report) before it's first saved. */
  populate?: (filesDir: string, name: string) => Promise<unknown>;
}

export interface OpenOptions extends WorkspaceOptions {
  /** Asked when the file has unsaved changes left from a crash. True to recover them. */
  askToRecover: (name: string, state: WorkspaceState) => Promise<boolean>;
}

const now = () => new Date().toISOString();

export function workspacePaths(root: string, id: string, filePath: string) {
  // Include the file's location so two copies of the same project never share a folder.
  const key = createHash('sha1')
    .update(path.resolve(filePath))
    .digest('hex')
    .slice(0, 8);
  const workspaceDir = path.join(root, `${id}-${key}`);
  return {
    workspaceDir,
    filesDir: path.join(workspaceDir, 'project'),
    statePath: path.join(workspaceDir, 'state.json'),
  };
}

/** A working folder's state, or null if it has none or it's unreadable. */
export function readWorkspaceState(
  statePath: string,
): Promise<WorkspaceState | null> {
  return readJson(statePath, (raw) => {
    const state = raw as Partial<WorkspaceState> | null;
    if (typeof state?.dirty !== 'boolean') return null;
    return {
      filePath: String(state.filePath ?? ''),
      dirty: state.dirty,
      updatedAt: String(state.updatedAt ?? ''),
    };
  });
}

async function writeWorkspaceState(ws: Workspace) {
  const state: WorkspaceState = {
    filePath: ws.filePath,
    dirty: ws.dirty,
    updatedAt: now(),
  };
  await writeJson(path.join(ws.workspaceDir, 'state.json'), state);
}

export function parseManifest(text: string): ProjectManifest {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new InvalidProjectFileError(
      'The project file is damaged: manifest.json is not valid JSON.',
    );
  }
  if (typeof manifest?.formatVersion !== 'number') {
    throw new InvalidProjectFileError(
      'The project file is damaged: it has no format version.',
    );
  }
  if (manifest.formatVersion > FORMAT_VERSION) {
    throw new InvalidProjectFileError(
      'This project was saved by a newer version of PawpawBI. Update PawpawBI to open it.',
    );
  }
  // The ID becomes part of a folder name, so only allow safe characters.
  if (
    typeof manifest.id !== 'string' ||
    !SAFE_ID.test(manifest.id) ||
    typeof manifest.name !== 'string'
  ) {
    throw new InvalidProjectFileError(
      'The project file is damaged: manifest.json is incomplete.',
    );
  }
  return manifest;
}

/** Before the ZIP format, a .pawpaw file was a small JSON file: { version, name, createdAt }. */
async function readLegacyProject(
  filePath: string,
  appLabel: string,
): Promise<ProjectManifest> {
  let data;
  try {
    data = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    throw new InvalidProjectFileError('This is not a PawpawBI project file.');
  }
  if (typeof data?.name !== 'string') {
    throw new InvalidProjectFileError('This is not a PawpawBI project file.');
  }
  return {
    formatVersion: FORMAT_VERSION,
    id: newId(),
    name: data.name,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : now(),
    modifiedAt: now(),
    createdWith: appLabel,
    modifiedWith: appLabel,
  };
}

/**
 * Opens a .pawpaw file into its working folder. If a crash left unsaved changes for this file,
 * asks whether to recover them; otherwise (or if not) the file is extracted afresh.
 */
export async function openWorkspace(
  filePath: string,
  options: OpenOptions,
): Promise<Workspace> {
  const isZip = await isZipFile(filePath);
  const manifest = isZip
    ? parseManifest(await readArchiveEntry(filePath, 'manifest.json'))
    : await readLegacyProject(filePath, options.appLabel);
  const paths = workspacePaths(options.root, manifest.id, filePath);

  const previous = await readWorkspaceState(paths.statePath);
  const recover =
    previous?.dirty === true &&
    (await options.askToRecover(manifest.name, previous));

  let current = manifest;
  if (recover) {
    // The recovered copy's manifest wins: it may have been renamed since the last save.
    try {
      current = parseManifest(
        await fs.readFile(path.join(paths.filesDir, 'manifest.json'), 'utf8'),
      );
    } catch {
      throw new InvalidProjectFileError(
        'The unsaved changes are damaged and can’t be recovered. Open the project again and choose Discard to use the last saved version.',
      );
    }
  } else {
    await removePath(paths.workspaceDir);
    await fs.mkdir(paths.filesDir, { recursive: true });
    if (isZip) {
      await extractArchive(filePath, paths.filesDir);
    } else {
      await writeJson(path.join(paths.filesDir, 'manifest.json'), manifest);
    }
  }

  const ws: Workspace = {
    manifest: current,
    filePath,
    workspaceDir: paths.workspaceDir,
    filesDir: paths.filesDir,
    // An old-format file is upgraded in the working folder and written as a ZIP on save.
    dirty: recover || !isZip,
  };
  await writeWorkspaceState(ws);
  return ws;
}

/** Creates a new, empty project file and its working folder. */
export async function createWorkspace(
  filePath: string,
  options: CreateOptions,
): Promise<Workspace> {
  const manifest: ProjectManifest = {
    formatVersion: FORMAT_VERSION,
    id: newId(),
    name: path.basename(filePath, path.extname(filePath)),
    createdAt: now(),
    modifiedAt: now(),
    createdWith: options.appLabel,
    modifiedWith: options.appLabel,
  };
  const paths = workspacePaths(options.root, manifest.id, filePath);
  await removePath(paths.workspaceDir);
  await writeJson(path.join(paths.filesDir, 'manifest.json'), manifest);
  await options.populate?.(paths.filesDir, manifest.name);
  await packArchive(paths.filesDir, filePath);

  const ws: Workspace = { manifest, filePath, ...paths, dirty: false };
  await writeWorkspaceState(ws);
  return ws;
}

/** Renames the project (its manifest's name; the file keeps its own name). */
export async function renameWorkspace(ws: Workspace, name: string) {
  ws.manifest = { ...ws.manifest, name };
  await writeJson(path.join(ws.filesDir, 'manifest.json'), ws.manifest);
}

/** Records that the project has unsaved changes, so a crash will offer them back. */
export async function markWorkspaceDirty(ws: Workspace): Promise<boolean> {
  if (ws.dirty) return false;
  ws.dirty = true;
  await writeWorkspaceState(ws);
  return true;
}

/** Saves the working folder to the .pawpaw file. */
export async function saveWorkspace(ws: Workspace, appLabel: string) {
  ws.manifest = { ...ws.manifest, modifiedAt: now(), modifiedWith: appLabel };
  await writeJson(path.join(ws.filesDir, 'manifest.json'), ws.manifest);
  await packArchive(ws.filesDir, ws.filePath);
  ws.dirty = false;
  await writeWorkspaceState(ws);
}

/** Deletes the working folder, when the project is closed (saved or not). */
export async function removeWorkspace(ws: Workspace) {
  await removePath(ws.workspaceDir);
}
