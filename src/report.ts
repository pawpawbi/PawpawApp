// Main-process side of Build visuals: the report site (report-site.ts), its datasets, showing
// it in the app and exporting it for hosting. Writing pages: docs/guides/report.md
//
// The site is shown from pawpaw-report://site/<path> in a sandboxed frame. Its pages are HTML
// and JavaScript from the project, which may come from someone else, so the frame can load only
// the site's own files and nothing from the network.
import {
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { work } from './background';
import { removePath } from './fs-json';
import {
  hasOpenProject,
  markProjectChanged,
  openProject,
  tracked,
} from './projects';
import { callPython } from './python';
import {
  SITE_TYPES,
  createPage,
  createSite,
  datasetFile,
  deletePage,
  exportSite,
  hasSite,
  readDatasets,
  readReport,
  readSiteFile,
  renamePage,
  renameReport,
  sitePath,
  writeDatasets,
  writeSiteFile,
  type DatasetEntry,
} from './report-site';
import { buildSingleFile } from './report-single-file';
import { SINGLE_FILE_SCRIPTS, SITE_TEMPLATES } from './report-templates';
import { GUID, NAME, NAME_RULE } from './shared/ids';
import { withoutOldMenu } from './shared/site-menu';
import type { Dataset, ReportFile, SavedReportFile } from './shared/types';
import { REPORT_ORIGIN, REPORT_SCHEME } from './shared/types';

/**
 * The Content Security Policy the site is shown with in the app: its own files, inline
 * scripts and styles, and data: images and fonts. Nothing from anywhere else, no frames, no
 * workers, no forms.
 */
const SITE_CSP = [
  "default-src 'none'",
  `script-src ${REPORT_ORIGIN} 'unsafe-inline'`,
  `style-src ${REPORT_ORIGIN} 'unsafe-inline'`,
  `img-src ${REPORT_ORIGIN} data: blob:`,
  `font-src ${REPORT_ORIGIN} data:`,
  `connect-src ${REPORT_ORIGIN}`,
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Must be called before the app is ready. */
export function registerReportScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: REPORT_SCHEME,
      // The sandboxed frame has an opaque origin, so fetching data/*.json is a CORS request.
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });

/** Serves pawpaw-report://site/<path> from the open project's report folder. */
async function serveSite(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== 'site' || !hasOpenProject()) return notFound();
  const file = sitePath(openProject().filesDir, url.pathname);
  if (!file) return notFound();
  let body: Uint8Array<ArrayBuffer> | string;
  try {
    body = await fs.readFile(file);
  } catch {
    return notFound();
  }
  // The app draws the menu above the page, so a page's own old one isn't shown.
  if (/^\/pages\/[^/]+\.html$/.test(url.pathname)) {
    body = withoutOldMenu(new TextDecoder().decode(body));
  }
  return new Response(body, {
    headers: {
      'Content-Type': SITE_TYPES[path.extname(file).toLowerCase()],
      'Content-Security-Policy': SITE_CSP,
      'Access-Control-Allow-Origin': '*',
      // Stops pages leaking data through DNS look-ups of links' host names.
      'X-DNS-Prefetch-Control': 'off',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * No web requests from the app's windows. The app's UI loads only bundled files (and the dev
 * server during development); connectors and the assistant reach the network from the main
 * process or Python, not from here. This stops a report page sending data out through
 * anything its Content Security Policy misses. The unreachable proxy, with the WebRTC policy
 * set in guardFrames, stops WebRTC, which goes through neither.
 */
export async function lockDownNetwork() {
  const devServer = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    : null;
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      const allowed =
        devServer !== null && new URL(details.url).host === devServer.host;
      callback({ cancel: !allowed });
    },
  );
  await session.defaultSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: '127.0.0.1:9',
    proxyBypassRules: devServer?.hostname ?? '',
  });
}

/**
 * Keeps the report frame on the report site: it can follow links between its own pages
 * (which the page tabs then follow) but not navigate anywhere else.
 */
export function guardFrames(contents: WebContents) {
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    if (!event.url.startsWith(`${REPORT_ORIGIN}/`)) {
      event.preventDefault();
      return;
    }
    const match = /\/pages\/([0-9a-f-]{36})\.html(?:[?#]|$)/.exec(event.url);
    if (match && GUID.test(match[1]))
      contents.send('report:navigated', match[1]);
  });
}

// ---------------------------------------------------------------------------------------------
// Datasets

const filesDir = () => openProject().filesDir;
const dataDir = () => path.join(filesDir(), 'data');

const toDataset = (
  name: string,
  { sql, rows, refreshedAt, error }: DatasetEntry,
): Dataset => ({ name, sql, rows, refreshedAt, error });

export async function listDatasets(): Promise<Dataset[]> {
  const file = await readDatasets(filesDir());
  return Object.entries(file.datasets)
    .map(([name, entry]) => toDataset(name, entry))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Runs one dataset's query and writes report/data/<name>.json. */
async function writeDataset(name: string, sql: string) {
  return callPython<{ rows: number; truncated: boolean }>('write_dataset', {
    data_dir: dataDir(),
    name,
    sql,
    path: datasetFile(filesDir(), name),
  });
}

export async function saveDataset(name: string, sql: string): Promise<Dataset> {
  if (!NAME.test(name)) throw new Error(`Dataset names: ${NAME_RULE}`);
  if (!sql.trim()) throw new Error('Enter a query for the dataset.');
  const result = await writeDataset(name, sql);
  const file = await readDatasets(filesDir());
  const now = new Date().toISOString();
  file.datasets[name] = {
    sql,
    updatedAt: now,
    rows: result.rows,
    refreshedAt: now,
  };
  await writeDatasets(filesDir(), file);
  await markProjectChanged();
  return toDataset(name, file.datasets[name]);
}

export async function deleteDataset(name: string) {
  const file = await readDatasets(filesDir());
  if (!(name in file.datasets)) return;
  delete file.datasets[name];
  await writeDatasets(filesDir(), file);
  await removePath(datasetFile(filesDir(), name));
  await markProjectChanged();
}

/**
 * Rewrites every dataset's data from the tables as they are now. Called after data loads and
 * rebuilds (data.ts), before exporting, and from the Refresh button. A dataset whose query
 * fails keeps its previous data and records the error. Marks the project changed itself, like
 * the other dataset functions, because the assistant's tools call these directly.
 */
export async function refreshDatasets(
  onProgress?: (message: string) => void,
): Promise<Dataset[]> {
  const file = await readDatasets(filesDir());
  const names = Object.keys(file.datasets);
  if (!names.length) return [];
  onProgress?.('Updating the report’s data…');
  for (const name of names) {
    work.checkCancelled();
    const entry = file.datasets[name];
    try {
      const result = await writeDataset(name, entry.sql);
      file.datasets[name] = {
        sql: entry.sql,
        updatedAt: entry.updatedAt,
        rows: result.rows,
        refreshedAt: new Date().toISOString(),
      };
    } catch (error) {
      work.checkCancelled();
      file.datasets[name] = {
        ...entry,
        error: (error as Error).message.replace(
          /^\w+(?:Error|Exception): /,
          '',
        ),
      };
    }
  }
  await writeDatasets(filesDir(), file);
  await markProjectChanged();
  return listDatasets();
}

// ---------------------------------------------------------------------------------------------
// Export

async function pickExportFolder(event: IpcMainInvokeEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)!;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Publish the report',
    buttonLabel: 'Publish here',
    message: 'Choose an empty folder for the report’s files.',
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? null : filePaths[0];
}

// eslint-disable-next-line no-control-regex
const NOT_IN_FILE_NAMES = /[\\/:*?"<>|\x00-\x1f]/g;

/** A file name from the report's title, without characters Windows doesn't allow. */
function fileNameFor(title: string) {
  const name = title
    .replace(NOT_IN_FILE_NAMES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return `${name || 'Report'}.html`;
}

async function pickExportFile(event: IpcMainInvokeEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)!;
  const { title } = await readReport(filesDir());
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save the report as a single file',
    defaultPath: fileNameFor(title),
    filters: [{ name: 'Web page', extensions: ['html'] }],
  });
  return canceled || !filePath ? null : filePath;
}

// ---------------------------------------------------------------------------------------------
// IPC

/**
 * Runs a change to the site's files (report-site.ts, which doesn't know about the open project)
 * as tracked work and marks the project changed.
 */
const change = <R>(label: string, operation: () => Promise<R>) =>
  tracked(label, async () => {
    const result = await operation();
    await markProjectChanged();
    return result;
  });

export function registerReportHandlers() {
  protocol.handle(REPORT_SCHEME, serveSite);

  ipcMain.handle(
    'report:get',
    async (): Promise<ReportFile | null> =>
      (await hasSite(filesDir())) ? readReport(filesDir()) : null,
  );
  ipcMain.handle('report:create-site', () =>
    change('Adding the report', async () =>
      (await hasSite(filesDir()))
        ? readReport(filesDir())
        : createSite(filesDir(), openProject().name, SITE_TEMPLATES),
    ),
  );
  ipcMain.handle('report:create-page', (_event, title: string) =>
    change('Adding a page', () =>
      createPage(filesDir(), title, SITE_TEMPLATES),
    ),
  );
  ipcMain.handle('report:rename', (_event, title: string) =>
    change('Renaming the report', () => renameReport(filesDir(), title)),
  );
  ipcMain.handle('report:rename-page', (_event, id: string, title: string) =>
    change('Renaming a page', () => renamePage(filesDir(), id, title)),
  );
  ipcMain.handle('report:delete-page', (_event, id: string) =>
    change('Deleting a page', () => deletePage(filesDir(), id)),
  );
  ipcMain.handle('report:read-file', (_event, file: string) =>
    readSiteFile(filesDir(), file),
  );
  ipcMain.handle('report:write-file', (_event, file: string, content: string) =>
    change('Saving a report file', () =>
      writeSiteFile(filesDir(), file, content),
    ),
  );
  ipcMain.handle('report:list-datasets', () => listDatasets());
  ipcMain.handle('report:save-dataset', (_event, name: string, sql: string) =>
    tracked('Saving a dataset', () => saveDataset(name, sql)),
  );
  ipcMain.handle('report:delete-dataset', (_event, name: string) =>
    tracked('Deleting a dataset', () => deleteDataset(name)),
  );
  ipcMain.handle('report:refresh-datasets', () =>
    tracked('Updating the report’s data', () => refreshDatasets()),
  );
  ipcMain.handle('report:export', async (event) => {
    const destination = await pickExportFolder(event);
    if (!destination) return null;
    await tracked('Publishing the report', async () => {
      await refreshDatasets();
      await exportSite(filesDir(), destination);
    });
    return destination;
  });
  ipcMain.handle(
    'report:export-file',
    async (event): Promise<SavedReportFile | null> => {
      const destination = await pickExportFile(event);
      if (!destination) return null;
      return tracked('Saving the report as a file', async () => {
        await refreshDatasets();
        work.checkCancelled();
        const html = await buildSingleFile(filesDir(), SINGLE_FILE_SCRIPTS);
        work.checkCancelled();
        await fs.writeFile(destination, html);
        return { path: destination, bytes: Buffer.byteLength(html) };
      });
    },
  );
}
