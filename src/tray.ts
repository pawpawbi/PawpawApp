// PawpawBI's icon in the system tray. Closing the window leaves PawpawBI running here, so
// published reports keep refreshing on schedule (scheduled-refresh.ts); its menu opens the
// window again or quits PawpawBI fully.
import { app, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';
import { onRefreshStatus, refreshStatus } from './scheduled-refresh';
import type { RefreshStatus } from './shared/types';

let tray: Tray | null = null;

const iconPath = () => {
  const name = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(app.getAppPath(), 'assets', name);
};

interface TrayActions {
  open: () => void;
  quit: () => void;
}

/** What the menu last showed, so it's only rebuilt when that changes (not every progress step). */
let shown: string | null | undefined;

function update(actions: TrayActions, status: RefreshStatus) {
  if (!tray) return;
  const refreshing = status.projectPath
    ? `Refreshing "${status.projectName}"…`
    : null;
  if (refreshing === shown) return;
  shown = refreshing;
  tray.setToolTip(refreshing ? `PawpawBI: ${refreshing}` : 'PawpawBI');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open PawpawBI', click: actions.open },
      ...(refreshing
        ? [
            { label: refreshing, enabled: false },
            { type: 'separator' as const },
          ]
        : [{ type: 'separator' as const }]),
      { label: 'Quit PawpawBI', click: actions.quit },
    ]),
  );
}

/** Puts PawpawBI in the system tray. */
export function createTray(actions: TrayActions) {
  tray = new Tray(nativeImage.createFromPath(iconPath()));
  tray.on('click', actions.open);
  tray.on('balloon-click', actions.open);
  update(actions, refreshStatus());
  onRefreshStatus((status) => update(actions, status));
}

/** A short notice from the tray icon (a Windows notification). */
export function notify(
  title: string,
  content: string,
  iconType: 'info' | 'warning' = 'info',
) {
  if (!tray || process.platform !== 'win32') return;
  tray.displayBalloon({ iconType, title, content });
}
