// The report site: report/ in a project is a static website (plain HTML, CSS and JavaScript)
// that can be hosted anywhere, e.g. S3 behind a CDN, with no part of PawpawBI.
// File format: docs/pawpaw-file-format.md. Writing pages: docs/guides/report.md
//
//   report/index.html            the landing page
//   report/report.json           { "title": "...", "pages": [{ "id": "<guid>", "title": "..." }] }
//   report/pages/<guid>.html     one file per page, without the menu (Publish adds it)
//   report/assets/report.css     the site's styles
//   report/assets/charts.js      the chart library
//   report/data/<dataset>.json   datasets: query results, written by the app (report.ts)
//   model/datasets.json          the datasets' queries (kept out of the site, not published)
//
// Projects may come from someone else, so everything read here is validated before use, and
// paths are only ever built from checked names.
//
// No Electron imports, so this is tested with plain Node (tests/node/report-site.test.ts).
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, removePath, writeJson } from './fs-json';
import { GUID, NAME } from './shared/ids';
import { withMenu } from './shared/site-menu';
import type { ReportFile, ReportPage } from './shared/types';

const MAX_TITLE = 80;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The site's files, with the content types they're served as. Nothing else is served. */
export const SITE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Text files a person or the assistant may edit: the pages, styles and scripts. */
const EDITABLE = new Set(['.html', '.css', '.js']);

/** The app's copies of the site's starting files (src/report-template/). */
export interface SiteTemplates {
  index: string;
  page: string;
  css: string;
  charts: string;
}

const reportDir = (filesDir: string) => path.join(filesDir, 'report');
const reportJsonPath = (filesDir: string) =>
  path.join(reportDir(filesDir), 'report.json');

const newGuid = () => crypto.randomUUID();

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

/** A title, tidied: one line, trimmed, at most MAX_TITLE characters. */
function cleanTitle(title: unknown): string {
  return typeof title === 'string'
    ? title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
    : '';
}

/** Keeps only well-formed pages with GUIDs, each once. */
export function cleanReport(value: unknown): ReportFile {
  const raw = value as { title?: unknown; pages?: unknown } | null;
  const pages: ReportPage[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw?.pages)) {
    for (const page of raw.pages) {
      const id = page?.id;
      if (typeof id !== 'string' || !GUID.test(id) || seen.has(id)) continue;
      seen.add(id);
      pages.push({ id, title: cleanTitle(page.title) || 'Untitled page' });
    }
  }
  return { title: cleanTitle(raw?.title) || 'Report', pages };
}

export async function hasSite(filesDir: string): Promise<boolean> {
  try {
    await fs.access(reportJsonPath(filesDir));
    return true;
  } catch {
    return false;
  }
}

export const readReport = (filesDir: string) =>
  readJson(reportJsonPath(filesDir), cleanReport);

const writeReport = (filesDir: string, report: ReportFile) =>
  writeJson(reportJsonPath(filesDir), cleanReport(report));

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in values ? escapeHtml(values[key]) : match,
  );

/**
 * Writes the default report into a new project (or one that has none): the landing page,
 * styles, chart library and one empty page.
 */
export async function createSite(
  filesDir: string,
  title: string,
  templates: SiteTemplates,
): Promise<ReportFile> {
  const dir = reportDir(filesDir);
  const reportTitle = cleanTitle(title) || 'Report';
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(dir, 'pages'), { recursive: true });
  await fs.mkdir(path.join(dir, 'data'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'index.html'),
    fill(templates.index, { title: reportTitle }),
  );
  await fs.writeFile(path.join(dir, 'assets', 'report.css'), templates.css);
  await fs.writeFile(path.join(dir, 'assets', 'charts.js'), templates.charts);
  await writeReport(filesDir, { title: reportTitle, pages: [] });
  await createPage(filesDir, 'Overview', templates);
  return readReport(filesDir);
}

/** Adds a page from the page template, at the end. */
export async function createPage(
  filesDir: string,
  title: string,
  templates: SiteTemplates,
): Promise<ReportPage> {
  const report = await readReport(filesDir);
  const page = { id: newGuid(), title: cleanTitle(title) || 'Untitled page' };
  await fs.mkdir(path.join(reportDir(filesDir), 'pages'), { recursive: true });
  await fs.writeFile(
    path.join(reportDir(filesDir), 'pages', `${page.id}.html`),
    fill(templates.page, { title: page.title }),
  );
  await writeReport(filesDir, { ...report, pages: [...report.pages, page] });
  return page;
}

async function findPage(filesDir: string, id: string) {
  const report = await readReport(filesDir);
  const page = report.pages.find((p) => p.id === id);
  if (!page)
    throw new Error('That page doesn’t exist. It may have been deleted.');
  return { report, page };
}

/** Renames a page in report.json. The page's own heading is part of its HTML. */
/** Changes the report's title, shown at the start of its menu and on its landing page. */
export async function renameReport(filesDir: string, title: string) {
  const clean = cleanTitle(title);
  if (!clean) throw new Error('Enter a title for the report.');
  await writeReport(filesDir, {
    ...(await readReport(filesDir)),
    title: clean,
  });
}

export async function renamePage(filesDir: string, id: string, title: string) {
  const clean = cleanTitle(title);
  if (!clean) throw new Error('Enter a title for the page.');
  const { report, page } = await findPage(filesDir, id);
  page.title = clean;
  await writeReport(filesDir, report);
}

export async function deletePage(filesDir: string, id: string) {
  const { report } = await findPage(filesDir, id);
  await writeReport(filesDir, {
    ...report,
    pages: report.pages.filter((p) => p.id !== id),
  });
  await removePath(path.join(reportDir(filesDir), 'pages', `${id}.html`));
}

/**
 * The file a site path refers to (e.g. "pages/<guid>.html"), or null if the path is unsafe
 * or isn't a kind of file the site serves. Hidden files and folders are never served.
 */
export function sitePath(filesDir: string, relative: string): string | null {
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  const parts = decoded.split('/').filter((p) => p !== '');
  if (
    !parts.length ||
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    parts.some((p) => p === '..' || p.startsWith('.') || /[:*?"<>|]/.test(p))
  ) {
    return null;
  }
  const extension = path.extname(parts[parts.length - 1]).toLowerCase();
  if (!(extension in SITE_TYPES)) return null;
  const root = reportDir(filesDir);
  const resolved = path.resolve(root, ...parts);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

/** An editable site file (a page, stylesheet or script) by its site path. */
function editablePath(filesDir: string, relative: string): string {
  const file = sitePath(filesDir, relative);
  if (!file || !EDITABLE.has(path.extname(file).toLowerCase())) {
    throw new Error(
      `${relative} isn’t a page, stylesheet or script in the report.`,
    );
  }
  if (relative.split('/')[0] === 'data') {
    throw new Error(
      'Files in data/ are written from datasets and can’t be edited.',
    );
  }
  return file;
}

export async function readSiteFile(
  filesDir: string,
  relative: string,
): Promise<string> {
  return fs.readFile(editablePath(filesDir, relative), 'utf8');
}

export async function writeSiteFile(
  filesDir: string,
  relative: string,
  content: string,
) {
  const file = editablePath(filesDir, relative);
  if (typeof content !== 'string') throw new Error('A file must be text.');
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
    throw new Error('This file is too big. Report files can be up to 2 MB.');
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/**
 * Copies the site to `destination` for hosting. The folder must be new or empty, so an
 * export never mixes with or overwrites other files. Hidden files (staging files) are left out.
 */
export async function exportSite(filesDir: string, destination: string) {
  const existing = await fs.readdir(destination).catch(() => null);
  if (existing && existing.length) {
    throw new Error('Choose an empty folder to export the report into.');
  }
  await fs.cp(reportDir(filesDir), destination, {
    recursive: true,
    filter: (source) => !path.basename(source).startsWith('.'),
  });
  // Each page gets the menu the app shows above it.
  const report = await readReport(filesDir);
  for (const page of report.pages) {
    const file = path.join(destination, 'pages', `${page.id}.html`);
    const html = await fs.readFile(file, 'utf8').catch(() => null);
    if (html !== null)
      await fs.writeFile(file, withMenu(html, report, page.id));
  }
}

// ---------------------------------------------------------------------------------------------
// Datasets (model/datasets.json)

export interface DatasetEntry {
  sql: string;
  updatedAt: string;
  /** Set when the last refresh failed. */
  error?: string;
  rows?: number;
  refreshedAt?: string;
}

export interface DatasetsFile {
  datasets: Record<string, DatasetEntry>;
}

const datasetsPath = (filesDir: string) =>
  path.join(filesDir, 'model', 'datasets.json');

export const datasetFile = (filesDir: string, name: string) => {
  if (!NAME.test(name)) throw new Error('Invalid dataset name.');
  return path.join(reportDir(filesDir), 'data', `${name}.json`);
};

export function cleanDatasets(value: unknown): DatasetsFile {
  const datasets: DatasetsFile['datasets'] = {};
  const raw = (value as { datasets?: unknown } | null)?.datasets;
  if (raw && typeof raw === 'object') {
    for (const [name, entry] of Object.entries(raw)) {
      const e = entry as Record<string, unknown>;
      if (!NAME.test(name) || typeof e?.sql !== 'string') continue;
      datasets[name] = {
        sql: e.sql,
        updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : '',
        ...(typeof e.error === 'string' ? { error: e.error } : {}),
        ...(Number.isFinite(e.rows) ? { rows: e.rows as number } : {}),
        ...(typeof e.refreshedAt === 'string'
          ? { refreshedAt: e.refreshedAt }
          : {}),
      };
    }
  }
  return { datasets };
}

export const readDatasets = (filesDir: string) =>
  readJson(datasetsPath(filesDir), cleanDatasets);

export const writeDatasets = (filesDir: string, file: DatasetsFile) =>
  writeJson(datasetsPath(filesDir), cleanDatasets(file));
