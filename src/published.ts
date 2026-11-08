// Publishing reports to PawpawBI and keeping their data fresh. A project records its published
// report in published.json; this computer keeps a list of every published project
// (published-reports.json in userData) for the Published projects screen. The list can always
// be rebuilt from the project files. Server API: docs/pawpaw-server-api.md
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { forgetIfSignedOut, signedInServer } from './account';
import { refreshAll } from './data';
import { readJson, removePath, writeJson } from './fs-json';
import { listFiles, readArchiveEntry } from './pawpaw-archive';
import {
  isGone,
  MissingFilesError,
  publishTargets,
  REPORT_ID,
  REPORT_VISIBILITIES,
  uploadFiles,
  packFile,
  type PawpawServer,
  type ServerReport,
} from './pawpaw-server';
import {
  closeProjectQuietly,
  hasOpenProject,
  markProjectChanged,
  onProjectOpened,
  openProject,
  openProjectInBackground,
  readRecents,
  saveProject,
  tracked,
} from './projects';
import {
  cleanList,
  cleanPublished,
  publishedFile,
  withEntry,
} from './published-files';
import { refreshDatasets } from './report';
import { exportSite, hasSite, readReport, SITE_TYPES } from './report-site';
import { parseManifest } from './workspace';
import type {
  PublishedOrg,
  PublishedProject,
  PublishedReport,
  PublishOptions,
  PublishOutcome,
  PublishProgress,
  ReportVisibility,
} from './shared/types';

/** Publishing over a report that's no longer there for this account (the server's 404). */
const GONE =
  'This report isn’t on PawpawBI any more: it was deleted, or your account can no longer reach it.';

// --- The project's record (published.json) -----------------------------------------------------

const publishedPath = (filesDir: string) =>
  path.join(filesDir, 'published.json');

const readPublished = (filesDir: string) =>
  readJson(publishedPath(filesDir), cleanPublished);

async function writePublished(report: PublishedReport) {
  await writeJson(publishedPath(openProject().filesDir), publishedFile(report));
  await markProjectChanged();
}

// --- This computer's list (published-reports.json) ---------------------------------------------

const listPath = () =>
  path.join(app.getPath('userData'), 'published-reports.json');

const readList = () => readJson(listPath(), cleanList);

const writeList = (list: PublishedProject[]) =>
  writeJson(listPath(), { projects: list });

/** Adds or updates the open project's entry in the list. */
async function listOpenProject(report: PublishedReport, lastError?: string) {
  const project = openProject();
  const entry: PublishedProject = {
    ...report,
    projectId: project.id,
    projectName: project.name,
    projectPath: project.filePath,
    ...(lastError ? { lastError } : {}),
  };
  await writeList(withEntry(await readList(), entry));
  return entry;
}

/** A published project in a .pawpaw file, read without opening it; null if it isn't one. */
async function entryFromFile(
  filePath: string,
): Promise<PublishedProject | null> {
  const report = cleanPublished(
    JSON.parse(await readArchiveEntry(filePath, 'published.json')),
  );
  if (!report) return null;
  const manifest = parseManifest(
    await readArchiveEntry(filePath, 'manifest.json'),
  );
  return {
    ...report,
    projectId: manifest.id,
    projectName: manifest.name,
    projectPath: filePath,
  };
}

/** The list, rebuilt from the recent projects' files if it's been lost. */
async function list(): Promise<PublishedProject[]> {
  const exists = await fs
    .access(listPath())
    .then(() => true)
    .catch(() => false);
  if (exists) return readList();
  let rebuilt: PublishedProject[] = [];
  for (const recent of await readRecents()) {
    const entry = await entryFromFile(recent.path).catch(() => null);
    if (entry) rebuilt = withEntry(rebuilt, entry);
  }
  await writeList(rebuilt);
  return rebuilt;
}

/** Adds published projects from files the user picks. Files that aren't published are skipped. */
async function addFiles(win: BrowserWindow): Promise<PublishedProject[]> {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Add published projects',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PawpawBI project', extensions: ['pawpaw'] }],
  });
  let entries = await list();
  if (canceled) return entries;
  const notPublished: string[] = [];
  for (const filePath of filePaths) {
    const entry = await entryFromFile(filePath).catch(() => null);
    if (entry) entries = withEntry(entries, entry);
    else notPublished.push(path.basename(filePath));
  }
  await writeList(entries);
  if (notPublished.length) {
    throw new Error(
      `${notPublished.join(', ')} ${notPublished.length === 1 ? "hasn't" : "haven't"} been published to PawpawBI, so ${notPublished.length === 1 ? "it wasn't" : "they weren't"} added.`,
    );
  }
  return entries;
}

// --- Publishing ------------------------------------------------------------------------------------

/** Runs `use` with a temporary folder that's removed afterwards. */
async function withTempDir<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawpaw-publish-'));
  try {
    return await use(dir);
  } finally {
    await removePath(dir);
  }
}

type Packed = ReturnType<typeof packFile>;

/** The files of a folder that the site serves (or those `include` picks), gzipped to upload. */
async function packFolder(
  dir: string,
  include: (file: string) => boolean = () => true,
): Promise<Packed[]> {
  const packed: Packed[] = [];
  for (const file of await listFiles(dir)) {
    const type = SITE_TYPES[path.extname(file).toLowerCase()];
    if (!type || !include(file)) continue;
    packed.push(
      packFile(
        file,
        await fs.readFile(path.join(dir, ...file.split('/'))),
        type,
      ),
    );
  }
  return packed;
}

/** The site as Publish to a folder writes it (with the menu in every page), gzipped. */
const packSite = (filesDir: string) =>
  withTempDir(async (dir) => {
    const site = path.join(dir, 'site');
    await exportSite(filesDir, site);
    return packFolder(site);
  });

/** The report's data files, gzipped. */
const packData = (filesDir: string) =>
  packFolder(path.join(filesDir, 'report'), (file) =>
    /^data\/[^/]+\.json$/.test(file),
  );

/** Tells every window how the upload is going (a progress bar). */
function sendProgress(progress: PublishProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('publish:progress', progress);
  }
}

/**
 * Uploads a new version of a report straight to S3 (a few files at a time, with progress),
 * then tells the server, which checks they're all there and makes it the current version.
 * Files it says are missing are uploaded once more.
 */
async function uploadVersion(
  server: PawpawServer,
  packed: Packed[],
  start: (files: Packed['file'][]) => ReturnType<PawpawServer['updateReport']>,
): Promise<ServerReport> {
  sendProgress({ stage: 'preparing', sent: 0, total: 0 });
  const { report, version, uploads } = await start(packed.map((p) => p.file));
  const progress = (sent: number, total: number) =>
    sendProgress({ stage: 'uploading', sent, total });
  await uploadFiles(server, packed, uploads, progress);
  sendProgress({ stage: 'finishing', sent: 1, total: 1 });
  try {
    return await server.completeUpload(report.id, version);
  } catch (error) {
    if (!(error instanceof MissingFilesError)) throw error;
    await uploadFiles(
      server,
      packed,
      uploads.filter((u) => error.missing.includes(u.path)),
      progress,
    );
    return server.completeUpload(report.id, version);
  }
}

/** The organisations the signed-in account can publish to (editor or above), personal first. */
async function targets() {
  const { server } = await signedInServer();
  return publishTargets(await server.orgs().catch(forgetIfSignedOut));
}

/** The options for a new report, checked: they come from the page. */
function cleanOptions(value: unknown): PublishOptions {
  const o = (value ?? {}) as PublishOptions;
  if (o.orgId !== undefined && !REPORT_ID.test(String(o.orgId))) {
    throw new Error('That organisation isn’t valid.');
  }
  if (
    o.visibility !== undefined &&
    !REPORT_VISIBILITIES.includes(o.visibility as ReportVisibility)
  ) {
    throw new Error('Choose who can open the report.');
  }
  return {
    orgId: o.orgId,
    visibility: o.visibility,
    asNew: o.asNew === true,
  };
}

/** The organisation `orgId` names, from what's known or the account's list. */
async function orgOf(
  server: PawpawServer,
  orgId: string | null,
  known: PublishedOrg | null,
): Promise<PublishedOrg | null> {
  if (!orgId || known?.id === orgId) return known;
  const org = (await server.orgs().catch(() => [])).find((o) => o.id === orgId);
  return org ? { id: org.id, name: org.name, personal: org.personal } : known;
}

/**
 * Publishes the open project's report to PawpawBI: the first time (or `asNew`), a new report,
 * where `options` say; after that, a new version of the same report, so its address doesn't
 * change. Who may publish it again is the server's decision (its organisation's roles). If the
 * report has gone, says so instead, so the page can offer to publish it as a new one.
 */
async function publishToPawpawBI(
  options: PublishOptions,
): Promise<PublishOutcome> {
  const { filesDir } = openProject();
  if (!(await hasSite(filesDir))) {
    throw new Error(
      'This project has no report yet. Add one on Build visuals.',
    );
  }
  return tracked('Publishing the report', async () => {
    const { server, saved } = await signedInServer();
    try {
      const previous = options.asNew ? null : await readPublished(filesDir);
      await refreshDatasets();
      const title = (await readReport(filesDir)).title;
      let hosted: ServerReport;
      try {
        hosted = await uploadVersion(
          server,
          await packSite(filesDir),
          (files) =>
            previous
              ? server.updateReport(previous.reportId, 'site', files)
              : server.createReport(title, files, {
                  orgId: options.orgId,
                  visibility: options.visibility,
                }),
        );
      } catch (error) {
        if (previous && isGone(error)) return { ok: false, gone: GONE };
        throw error;
      }
      const report: PublishedReport = {
        reportId: hosted.id,
        url: hosted.url,
        account: saved.account.email,
        org: await orgOf(server, hosted.orgId, previous?.org ?? null),
        visibility: hosted.visibility ?? previous?.visibility ?? null,
        publishedAt: hosted.publishedAt,
        refreshedAt: hosted.refreshedAt,
      };
      await writePublished(report);
      await listOpenProject(report);
      return { ok: true, report };
    } catch (error) {
      return forgetIfSignedOut(error);
    }
  });
}

/** Takes a project off this computer's list. Opening it again lists it again. */
async function forget(projectPath: string): Promise<PublishedProject[]> {
  const entries = (await list()).filter((e) => e.projectPath !== projectPath);
  await writeList(entries);
  return entries;
}

/**
 * Refreshes a published project from the start screen: opens it in the background, loads every
 * data source again (rebuilding tables and datasets), uploads the report's new data, saves the
 * project and closes it.
 */
async function refresh(projectPath: string): Promise<PublishedProject> {
  if (hasOpenProject()) throw new Error('Close the open project first.');
  const entry = (await list()).find((e) => e.projectPath === projectPath);
  if (!entry) throw new Error('That project isn’t in the published list.');
  const remember = async (lastError: string) => {
    const failed = { ...entry, lastError };
    await writeList(withEntry(await readList(), failed));
    return failed;
  };
  try {
    await fs.access(projectPath);
  } catch {
    await remember(
      'The project file couldn’t be found. Was it moved or renamed?',
    );
    throw new Error(
      `"${entry.projectName}" couldn't be found at ${projectPath}. If it was moved, add it again with Add a project.`,
    );
  }

  const { server } = await signedInServer();
  await openProjectInBackground(projectPath);
  try {
    const { filesDir } = openProject();
    const report = await readPublished(filesDir);
    if (!report) throw new Error('This project isn’t published any more.');
    const { updated, problems } = await tracked(
      'Refreshing the published report',
      async () => {
        const result = await refreshAll();
        const hosted = await uploadVersion(
          server,
          await packData(filesDir),
          (files) => server.updateReport(report.reportId, 'data', files),
        ).catch((error) => {
          if (isGone(error)) {
            throw new Error(
              `${GONE} Open the project and publish it again as a new report, or forget it here.`,
            );
          }
          return forgetIfSignedOut(error);
        });
        const updated = {
          ...report,
          visibility: hosted.visibility ?? report.visibility,
          refreshedAt: hosted.refreshedAt,
        };
        await writePublished(updated);
        const problems = [
          ...result.failedSources.map((s) => `${s.name}: ${s.error}`),
          ...result.failedTables.map((t) => `${t.name}: ${t.error}`),
        ];
        return { updated, problems };
      },
    );
    // After the task: saving waits for the project's background work to finish.
    await saveProject();
    return await listOpenProject(
      updated,
      problems.length
        ? `Refreshed, with problems. ${problems.join(' ')}`
        : undefined,
    );
  } catch (error) {
    await remember((error as Error).message);
    throw error;
  } finally {
    await closeProjectQuietly();
  }
}

export function registerPublishHandlers() {
  // A published project opened on this computer is (re)listed, with its current path.
  onProjectOpened(async () => {
    const report = await readPublished(openProject().filesDir);
    if (report) await listOpenProject(report);
  });

  ipcMain.handle('publish:get', () => readPublished(openProject().filesDir));
  ipcMain.handle('publish:to-pawpawbi', (_event, options: unknown) =>
    publishToPawpawBI(cleanOptions(options)),
  );
  ipcMain.handle('publish:targets', () => targets());
  ipcMain.handle('publish:list', () => list());
  ipcMain.handle('publish:forget', (_event, projectPath: string) =>
    forget(String(projectPath)),
  );
  ipcMain.handle('publish:refresh', (_event, projectPath: string) =>
    refresh(String(projectPath)),
  );
  ipcMain.handle('publish:add-files', (event) =>
    addFiles(BrowserWindow.fromWebContents(event.sender)!),
  );
}
