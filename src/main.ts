import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerAccountHandlers } from './account';
import { registerAssistantHandlers } from './assistant';
import { work } from './background';
import { registerDataHandlers } from './data';
import {
  closeProject,
  hasOpenProject,
  registerProjectHandlers,
} from './projects';
import { registerPublishHandlers } from './published';
import { registerPythonHandlers } from './python';
import {
  guardFrames,
  lockDownNetwork,
  registerReportHandlers,
  registerReportScheme,
} from './report';
import {
  applyStartAtLogin,
  onScheduledProblem,
  readSettings,
  refreshStatus,
  registerScheduledRefresh,
  START_HIDDEN,
  stopRefresh,
  updateSettings,
  wantedAtSignIn,
} from './scheduled-refresh';
import { createTray, notify } from './tray';

// Uninstalling: stop starting at sign-in, as Update.exe is about to be removed. Never let this
// get in the way of the uninstall.
if (process.argv.includes('--squirrel-uninstall')) {
  try {
    applyStartAtLogin(false);
  } catch (error) {
    console.error('Removing the sign-in entry:', error);
  }
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// One PawpawBI at a time: it keeps running in the tray, and two would both run the schedules.
// Starting it again shows the running one's window.
const firstInstance = started || app.requestSingleInstanceLock();
if (!firstInstance) app.quit();

// The report is shown from its own scheme, which has to be registered before start-up.
registerReportScheme();

const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(app.getAppPath(), 'assets', 'icon.png');

let mainWindow: BrowserWindow | null = null;

/** True once the user chose Quit: closing the window then quits PawpawBI too. */
let quitting = false;

const createWindow = () => {
  // Create the browser window.
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#f6f5f2',
    title: 'PawpawBI',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = win;

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // The report frame can't leave the report site or use WebRTC.
  guardFrames(win.webContents);

  // Links such as connector docs open in the user's browser, never in a new app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Close the open project first, so the user can save unsaved changes or cancel closing.
  let projectClosed = false;
  win.on('close', (event) => {
    if (projectClosed || !hasOpenProject()) return;
    event.preventDefault();
    closeProject(win)
      .then((closed) => {
        if (!closed) {
          quitting = false;
          return;
        }
        projectClosed = true;
        win.close();
      })
      .catch((error: Error) => {
        quitting = false;
        dialog.showErrorBox("Couldn't save the project", error.message);
      });
  });

  // The window is gone, but PawpawBI stays in the tray (unless the user chose Quit).
  win.on('closed', () => {
    mainWindow = null;
    if (quitting) app.quit();
    else void sayStillRunning();
  });

  // Open the DevTools in their own window during development so they don't squash the layout.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
};

/** Shows the window, opening it again if it was closed to the tray. */
function showWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** The first time the window closes to the tray, says that PawpawBI is still running. */
async function sayStillRunning() {
  const settings = await readSettings().catch(() => null);
  if (!settings || settings.trayNoticeShown) return;
  notify(
    'PawpawBI is still running',
    'It stays here to refresh your published reports on schedule. To quit, right-click its icon and choose Quit PawpawBI.',
  );
  await updateSettings({ trayNoticeShown: true }).catch(() => {});
}

/** Quits PawpawBI fully (the tray's Quit), after asking about a refresh in progress. */
async function quitFully() {
  const status = refreshStatus();
  if (status.projectPath) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Stop and quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Still refreshing',
      message: `"${status.projectName}" is being refreshed.`,
      detail:
        'Quitting stops the refresh, and the project and its published report keep their last data. If the new data is already uploading, that finishes first.',
    });
    if (response === 1) return;
    await stopRefresh();
  }
  quitting = true;
  // Closing the window asks to save the open project first; the app quits once it's closed.
  if (mainWindow) mainWindow.close();
  else app.quit();
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  if (started || !firstInstance) return;
  if (process.argv.includes(START_HIDDEN) && !(await wantedAtSignIn())) {
    app.quit();
    return;
  }
  await lockDownNetwork();
  ipcMain.handle('app:get-version', () => app.getVersion());
  registerProjectHandlers();
  registerPythonHandlers();
  registerDataHandlers();
  registerReportHandlers();
  registerAssistantHandlers();
  registerAccountHandlers();
  registerPublishHandlers();
  registerScheduledRefresh();

  // No File/Edit/View/Window menu bar: everything is in the app's own screens.
  Menu.setApplicationMenu(null);
  createTray({ open: showWindow, quit: () => void quitFully() });
  onScheduledProblem((title, detail) => notify(title, detail, 'warning'));

  // Started by Windows at sign-in: stay in the tray until the user opens the window.
  if (!process.argv.includes(START_HIDDEN)) createWindow();

  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
});

// Stop any connector processes still running (e.g. the app quit some other way), so none are
// left behind writing into a deleted folder.
app.on('will-quit', () => work.cancel());

// Closing the window doesn't quit: PawpawBI stays in the tray to run scheduled refreshes.
// Quit PawpawBI on the tray's menu quits.
app.on('window-all-closed', () => {});
