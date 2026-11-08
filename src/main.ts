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

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// The report is shown from its own scheme, which has to be registered before start-up.
registerReportScheme();

const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(app.getAppPath(), 'assets', 'icon.png');

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
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

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // The report frame can't leave the report site or use WebRTC.
  guardFrames(mainWindow.webContents);

  // Links such as connector docs open in the user's browser, never in a new app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Close the open project first, so the user can save unsaved changes or cancel closing.
  let projectClosed = false;
  mainWindow.on('close', (event) => {
    if (projectClosed || !hasOpenProject()) return;
    event.preventDefault();
    closeProject(mainWindow)
      .then((closed) => {
        if (!closed) return;
        projectClosed = true;
        mainWindow.close();
      })
      .catch((error: Error) =>
        dialog.showErrorBox("Couldn't save the project", error.message),
      );
  });

  // Open the DevTools in their own window during development so they don't squash the layout.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  await lockDownNetwork();
  ipcMain.handle('app:get-version', () => app.getVersion());
  registerProjectHandlers();
  registerPythonHandlers();
  registerDataHandlers();
  registerReportHandlers();
  registerAssistantHandlers();
  registerAccountHandlers();
  registerPublishHandlers();

  // No File/Edit/View/Window menu bar: everything is in the app's own screens.
  Menu.setApplicationMenu(null);
  createWindow();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Stop any connector processes still running (e.g. the app quit some other way), so none are
// left behind writing into a deleted folder.
app.on('will-quit', () => work.cancel());

// Quit when all windows are closed, except on macOS, where apps stay active until Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
