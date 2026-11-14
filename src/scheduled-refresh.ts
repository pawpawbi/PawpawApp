// Refreshing published projects in the background: by hand from Published projects, or by
// themselves on their schedules (weekly or monthly, src/shared/schedule.ts), one at a time.
// Each refresh works on its own copy of the project (published.ts refreshProject,
// project-context.ts), so it runs whether or not a project is open in the window, and while the
// window is closed to the system tray (main.ts). A project open in the window is refreshed once
// it's closed. A time missed while PawpawBI wasn't running (or the computer was asleep) is run
// once, as soon as it is.
//
// Also: starting PawpawBI in the tray when the user signs in to Windows (background.json in
// userData holds that choice).
import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from 'electron';
import path from 'node:path';
import { CancelledError, work } from './background';
import { readJson, writeJson } from './fs-json';
import { readArchiveEntry } from './pawpaw-archive';
import { onBeforeOpening, windowProject } from './projects';
import { list, refreshProject, updateEntry } from './published';
import { stopBackgroundPython } from './python';
import { checkSchedule, isDue } from './shared/schedule';
import type { PublishedProject, RefreshStatus } from './shared/types';
import { parseManifest } from './workspace';

/** Passed when Windows starts PawpawBI at sign-in: it starts in the tray, with no window. */
export const START_HIDDEN = '--hidden';

/** How often to look for a scheduled refresh that's due. */
const CHECK_EVERY = 30_000;

// --- What's running ----------------------------------------------------------------------------

const IDLE: RefreshStatus = {
  projectPath: null,
  projectName: '',
  scheduled: false,
  message: '',
  upload: null,
};

let status = IDLE;
let running: {
  projectPath: string;
  projectId: string;
  finished: Promise<void>;
} | null = null;

const statusListeners = new Set<(status: RefreshStatus) => void>();

/** Called as a refresh starts, goes and ends (the tray shows it). */
export const onRefreshStatus = (listener: (status: RefreshStatus) => void) =>
  statusListeners.add(listener);

function setStatus(next: RefreshStatus) {
  status = next;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('publish:refresh-status', status);
  }
  for (const listener of statusListeners) listener(status);
}

export const refreshStatus = () => status;

const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

/**
 * Whether the window has this project open (the same file, or a copy of it: copies share a
 * project ID, and with it their connectors' saved state). Such a project isn't refreshed.
 */
function openInWindow(entry: PublishedProject) {
  const open = windowProject();
  return (
    !!open &&
    (open.id === entry.projectId || samePath(open.filePath, entry.projectPath))
  );
}

/** Refreshes one project in the background. Only one runs at a time. */
async function run(
  entry: PublishedProject,
  scheduled: boolean,
): Promise<PublishedProject> {
  if (running) {
    throw new Error(
      `"${status.projectName}" is being refreshed. Try again when it finishes.`,
    );
  }
  if (openInWindow(entry)) {
    throw new Error('This project is open. Close it first, then refresh it.');
  }
  setStatus({
    projectPath: entry.projectPath,
    projectName: entry.projectName,
    scheduled,
    message: 'Opening the project…',
    upload: null,
  });
  const refreshing = refreshProject(entry.projectPath, {
    onMessage: (message) => setStatus({ ...status, message, upload: null }),
    onUpload: (upload) =>
      setStatus({
        ...status,
        message: 'Uploading the report’s data…',
        upload,
      }),
  });
  running = {
    projectPath: entry.projectPath,
    projectId: entry.projectId,
    finished: refreshing.then(
      () => {},
      () => {},
    ),
  };
  try {
    return await refreshing;
  } finally {
    running = null;
    setStatus(IDLE);
  }
}

/** Stops the running refresh, if any, and waits for it to end. The project file is untouched. */
export async function stopRefresh() {
  const current = running;
  if (!current) return;
  work.cancel(current.projectId);
  stopBackgroundPython();
  await current.finished;
}

/** Refreshes a published project now (Refresh data). */
async function refreshNow(projectPath: string) {
  const entry = (await list()).find((e) => e.projectPath === projectPath);
  if (!entry) throw new Error('That project isn’t in the published list.');
  return run(entry, false);
}

// --- Schedules ---------------------------------------------------------------------------------

/** Told how each scheduled refresh went, when it didn't go cleanly (the tray says so). */
let reportProblem: (title: string, detail: string) => void = () => {};

export const onScheduledProblem = (report: typeof reportProblem) => {
  reportProblem = report;
};

let checking = false;

/** Runs every scheduled refresh that's due, one after another. */
async function runDue() {
  if (checking || running) return;
  checking = true;
  // Each at most once per check, even if recording that it ran fails.
  const tried = new Set<string>();
  try {
    for (;;) {
      const now = new Date();
      const due = (await list()).find(
        (e) =>
          e.schedule &&
          !tried.has(e.projectPath) &&
          isDue(e.schedule, e.scheduleDoneUntil, now) &&
          !openInWindow(e),
      );
      // A refresh by hand may have started meanwhile; this one waits for the next check.
      if (!due || running) return;
      tried.add(due.projectPath);
      try {
        const refreshed = await run(due, true);
        if (refreshed.lastError) {
          reportProblem(
            `Refreshed "${due.projectName}", with problems`,
            refreshed.lastError,
          );
        }
      } catch (error) {
        if (error instanceof CancelledError) return;
        reportProblem(
          `Couldn't refresh "${due.projectName}"`,
          (error as Error).message,
        );
      }
    }
  } catch (error) {
    console.error('Checking refresh schedules:', error);
  } finally {
    checking = false;
  }
}

/** Sets or removes a project's schedule. Times before now don't count as missed. */
async function setSchedule(projectPath: string, value: unknown) {
  const schedule = value === null ? null : checkSchedule(value);
  const entries = await updateEntry(projectPath, (e) => {
    const { schedule: _old, scheduleDoneUntil: _done, ...rest } = e;
    return schedule
      ? { ...rest, schedule, scheduleDoneUntil: new Date().toISOString() }
      : rest;
  });
  // The first schedule turns on starting with Windows, unless the user has chosen already.
  if (schedule && (await readSettings()).startAtLogin === undefined) {
    await setStartAtLogin(true);
  }
  return entries;
}

// --- Starting with Windows ---------------------------------------------------------------------

interface BackgroundSettings {
  /** The user's choice; undefined until they make one (or add their first schedule). */
  startAtLogin?: boolean;
  /** Whether the "still running in the tray" notice has been shown once. */
  trayNoticeShown?: boolean;
}

const settingsPath = () =>
  path.join(app.getPath('userData'), 'background.json');

export const readSettings = () =>
  readJson(settingsPath(), (raw): BackgroundSettings => {
    const s = (raw ?? {}) as BackgroundSettings;
    return {
      ...(typeof s.startAtLogin === 'boolean'
        ? { startAtLogin: s.startAtLogin }
        : {}),
      trayNoticeShown: s.trayNoticeShown === true,
    };
  });

export async function updateSettings(change: Partial<BackgroundSettings>) {
  await writeJson(settingsPath(), { ...(await readSettings()), ...change });
}

/**
 * The installed app starts through Squirrel's Update.exe, whose path stays the same across
 * updates (the app's own folder changes with each version).
 */
function loginItem() {
  return {
    path: path.resolve(path.dirname(process.execPath), '..', 'Update.exe'),
    args: [
      '--processStart',
      `"${path.basename(process.execPath)}"`,
      '--process-start-args',
      `"${START_HIDDEN}"`,
    ],
  };
}

/** True in the Microsoft Store (MSIX) build. */
const isStoreBuild = () => process.windowsStore === true;

/**
 * Whether to go on after Windows started PawpawBI at sign-in. The Microsoft Store build can't
 * register and unregister itself: its package always asks Windows to start it at sign-in (the
 * start-up task in msix/AppxManifest.xml), so it stops straight away unless the user chose that.
 */
export const wantedAtSignIn = async () =>
  !isStoreBuild() || (await readSettings()).startAtLogin === true;

/**
 * Registers (or not) PawpawBI to start at sign-in. Only the app installed by its own installer
 * on Windows does; see wantedAtSignIn for the Microsoft Store build.
 */
export function applyStartAtLogin(on: boolean) {
  if (!app.isPackaged || process.platform !== 'win32' || isStoreBuild()) return;
  app.setLoginItemSettings({ openAtLogin: on, ...loginItem() });
}

async function setStartAtLogin(on: boolean) {
  await updateSettings({ startAtLogin: on });
  applyStartAtLogin(on);
  return on;
}

// --- Opening a project that's being refreshed --------------------------------------------------

/** The project ID in a .pawpaw file, or null if it can't be read. */
async function projectIdOf(filePath: string) {
  try {
    return parseManifest(await readArchiveEntry(filePath, 'manifest.json')).id;
  } catch {
    return null;
  }
}

/** Before the window opens a project being refreshed: wait for the refresh, or stop it. */
async function beforeOpening(filePath: string, win: BrowserWindow) {
  const current = running;
  if (!current) return true;
  if (
    !samePath(current.projectPath, filePath) &&
    (await projectIdOf(filePath)) !== current.projectId
  ) {
    return true;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Wait', 'Stop the refresh', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Refreshing in the background',
    message: `"${status.projectName}" is being refreshed in the background.`,
    detail:
      'Wait opens it as soon as the refresh finishes, with the new data. Stop the refresh opens it as it was before (if the new data is already uploading, that finishes first).',
  });
  if (response === 2) return false;
  if (response === 1) await stopRefresh();
  else await current.finished;
  return true;
}

// --- Start-up ----------------------------------------------------------------------------------

export function registerScheduledRefresh() {
  ipcMain.handle('publish:refresh', (_event, projectPath: string) =>
    refreshNow(String(projectPath)),
  );
  ipcMain.handle('publish:refresh-status', () => status);
  ipcMain.handle(
    'publish:set-schedule',
    (_event, projectPath: string, schedule: unknown) =>
      setSchedule(String(projectPath), schedule),
  );
  ipcMain.handle(
    'publish:get-start-at-login',
    async () => (await readSettings()).startAtLogin === true,
  );
  ipcMain.handle('publish:set-start-at-login', (_event, on: unknown) =>
    setStartAtLogin(on === true),
  );
  onBeforeOpening(beforeOpening);

  // Keep the registration in step with the choice (e.g. after reinstalling).
  readSettings()
    .then((s) => {
      if (s.startAtLogin !== undefined) applyStartAtLogin(s.startAtLogin);
    })
    .catch(() => {});

  // Look for due refreshes regularly, and at once after the computer wakes up. The first look
  // waits a little, so starting PawpawBI isn't slowed down.
  const check = () => void runDue();
  setTimeout(check, 10_000);
  setInterval(check, CHECK_EVERY);
  powerMonitor.on('resume', check);
  powerMonitor.on('unlock-screen', check);
}
