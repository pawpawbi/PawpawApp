// Starting at sign-in in the Microsoft Store (MSIX) build. Its package declares a start-up task
// (msix/AppxManifest.xml) that the user turns on and off in Windows' settings (Apps, then
// Startup): PawpawBI can't, as that takes a Windows API Electron doesn't have. This reads what
// Windows recorded, from the registry, to tell the user whether it's on. No Electron imports,
// so it's tested with plain Node.
import { execFile } from 'node:child_process';

/** The TaskId of the start-up task in msix/AppxManifest.xml. */
const STARTUP_TASK_ID = 'PawpawBIStartup';

/** Where Windows keeps each package's settings, the start-up tasks' states among them. */
const PACKAGES_KEY =
  'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\SystemAppData';

/** Windows' page of apps that start at sign-in. */
export const STARTUP_SETTINGS_URL = 'ms-settings:startupapps';

function reg(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'reg.exe',
      ['query', ...args],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * The start-up task's key, from `reg query … /s /k /e /f <task id>`: the one of the package
 * this program runs from (named <name>_<publisher id>, and installed in a folder named
 * <name>_<version>_<architecture>__<publisher id>), or else the only one there is.
 */
export function taskKey(found: string, execPath: string) {
  const keys = found
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith(`\\${STARTUP_TASK_ID}`));
  const own = keys.find((key) => {
    const [name, publisher] = (key.split('\\').at(-2) ?? '').split('_');
    return (
      !!name &&
      !!publisher &&
      execPath.includes(`\\${name}_`) &&
      execPath.includes(`__${publisher}\\`)
    );
  });
  return own ?? (keys.length === 1 ? keys[0] : null);
}

/**
 * Whether the task is on, from `reg query <its key> /v State`: Windows' StartupTaskState, where
 * 2 is on and 4 is on by the organisation's policy. Null if there's no state.
 */
export function taskOn(queried: string) {
  const match = /^\s*State\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im.exec(queried);
  if (!match) return null;
  const state = parseInt(match[1], 16);
  return state === 2 || state === 4;
}

/** Whether Windows starts PawpawBI at sign-in, or null if that can't be found out. */
export async function startupTaskOn(execPath: string) {
  try {
    const key = taskKey(
      await reg([PACKAGES_KEY, '/s', '/k', '/e', '/f', STARTUP_TASK_ID]),
      execPath,
    );
    return key ? taskOn(await reg([key, '/v', 'State'])) : null;
  } catch {
    return null;
  }
}
