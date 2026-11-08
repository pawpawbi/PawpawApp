// Main-process side of getting data: the connector catalog, data sources saved in the open
// project (sources/<id>.json), each connector's Python environment, and running connector jobs
// with python/sidecar/runner.py. File format: docs/pawpaw-file-format.md
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { CancelledError, work } from './background';
import { deleteSecrets, readSecrets, writeSecrets } from './credentials';
import { readJson, removePath, writeJson } from './fs-json';
import { markProjectChanged, openProject, tracked } from './projects';
import { refreshDatasets } from './report';
import {
  PYTHON_FLAGS,
  callPython,
  pythonEnv,
  pythonExe,
  pythonRoot,
  sidecarDir,
} from './python';
import {
  buildOrder,
  directDependents,
  downstreamOf,
  findCycle,
  type DependencyMap,
} from './shared/dependencies';
import { NAME, NAME_RULE, SAFE_ID, SAFE_TABLE, newId } from './shared/ids';
import type {
  ConnectorCatalog,
  ConnectorField,
  ConnectorInfo,
  DataProgress,
  DataSource,
  DiscoveredResource,
  LoadedTable,
  ModelDiagram,
  RefreshAllResult,
  SaveSourceInput,
  SaveTransformedInput,
  TableKind,
  TablePreview,
  TableSchema,
  TransformedTable,
} from './shared/types';
import { ALL_SOURCES } from './shared/types';

// Paths inside the open project's working folder.
const filesDir = () => openProject().filesDir;
const sourcesDir = () => path.join(filesDir(), 'sources');
const dataDir = () => path.join(filesDir(), 'data');
const diagramPath = () => path.join(filesDir(), 'model', 'diagram.json');
const transformsPath = () => path.join(filesDir(), 'model', 'transforms.json');
const transformedPath = () =>
  path.join(filesDir(), 'model', 'transformed.json');

// ---------------------------------------------------------------------------------------------
// Connector catalog (defined in python/sidecar/connectors)

let catalogRequest: Promise<ConnectorCatalog> | null = null;

export function catalog(): Promise<ConnectorCatalog> {
  catalogRequest ??= callPython<ConnectorCatalog>('catalog').catch((error) => {
    catalogRequest = null; // Retry next time.
    throw error;
  });
  return catalogRequest;
}

export async function connector(id: string): Promise<ConnectorInfo> {
  const found = (await catalog()).connectors.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown connector: ${id}`);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Data sources in the open project

/** sources/<id>.json. Secrets are never stored here; see credentials.ts. */
export interface SourceFile {
  id: string;
  type: string;
  name: string;
  options: Record<string, unknown>;
  resources: string[];
  tables: string[];
  lastLoadedAt: string | null;
}

function sourcePath(id: string) {
  if (!SAFE_ID.test(id)) throw new Error('Invalid data source ID.');
  return path.join(sourcesDir(), `${id}.json`);
}

export async function readSource(id: string): Promise<SourceFile> {
  const source = JSON.parse(await fs.readFile(sourcePath(id), 'utf8'));
  return {
    id,
    type: String(source.type),
    name: String(source.name ?? source.type),
    options: source.options ?? {},
    resources: Array.isArray(source.resources) ? source.resources : [],
    tables: Array.isArray(source.tables) ? source.tables : [],
    lastLoadedAt: source.lastLoadedAt ?? null,
  };
}

async function writeSource(source: SourceFile) {
  await writeJson(sourcePath(source.id), source);
  await markProjectChanged();
}

export async function readAllSources(): Promise<SourceFile[]> {
  let names: string[];
  try {
    names = await fs.readdir(sourcesDir());
  } catch {
    return [];
  }
  const sources: SourceFile[] = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, '');
    if (!name.endsWith('.json') || !SAFE_ID.test(id)) continue;
    try {
      sources.push(await readSource(id));
    } catch {
      // Skip a damaged file rather than hide every source.
    }
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

export async function toDataSource(source: SourceFile): Promise<DataSource> {
  const secrets = await readSecrets(openProject().id, source.id).catch(
    () => ({}),
  );
  return { ...source, savedSecrets: Object.keys(secrets) };
}

/** Saves a source's settings. A new one gets `newSourceId`, so a caller can know it first. */
export async function saveSource(
  input: SaveSourceInput,
  newSourceId = newId(),
): Promise<DataSource> {
  const existing = input.id ? await readSource(input.id) : null;
  const info = await connector(existing?.type ?? input.type);
  const id = existing?.id ?? newSourceId;
  const projectId = openProject().id;

  // Split the form into settings saved in the project and secrets kept on this computer.
  const options: Record<string, unknown> = {};
  const secrets = existing ? await readSecrets(projectId, id) : {};
  for (const field of info.fields) {
    const value = input.settings[field.key];
    if (field.secret) {
      // An empty secret field means "keep the saved value".
      if (typeof value === 'string' && value !== '') secrets[field.key] = value;
    } else if (value !== undefined && value !== null && value !== '') {
      options[field.key] = value;
    }
  }
  await writeSecrets(projectId, id, secrets);

  const source: SourceFile = {
    id,
    type: info.id,
    name: input.name.trim() || info.name,
    options,
    resources: existing?.resources ?? [],
    tables: existing?.tables ?? [],
    lastLoadedAt: existing?.lastLoadedAt ?? null,
  };
  await writeSource(source);
  return toDataSource(source);
}

/**
 * Removes loaded tables' data (original and in-place transform result, which would otherwise
 * still be shown in place of a later load of the same name) and their transforms.
 */
async function removeTables(tables: string[]) {
  const safe = tables.filter((t) => SAFE_TABLE.test(t));
  for (const table of safe) {
    for (const dataset of ['raw', 'model']) {
      await fs.rm(path.join(dataDir(), dataset, table), {
        recursive: true,
        force: true,
        maxRetries: 5,
      });
    }
  }
  const transforms = await readTransforms();
  if (safe.some((t) => t in transforms.tables)) {
    for (const t of safe) delete transforms.tables[t];
    await writeTransforms(transforms);
  }
}

/** Removes a source, its loaded tables and its saved secrets. Refused while others read them. */
export async function removeSource(id: string) {
  const source = await readSource(id);
  const users = await dependentsOf(source.tables);
  if (users.length) {
    throw new Error(
      `${users.join(', ')} ${users.length === 1 ? 'uses' : 'use'} tables from this source. Change or delete ${users.length === 1 ? 'it' : 'them'} first.`,
    );
  }
  await removeTables(source.tables);
  await deleteSecrets(openProject().id, id);
  await removePath(sourcePath(id));
  await markProjectChanged();
}

// ---------------------------------------------------------------------------------------------
// Connector environments
//
// Connectors that need extra Python packages get their own environment in
// userData/connector-envs/<connector id>, created on first use. It's layered on the bundled
// Python (--system-site-packages), so it shares dlt, pyarrow, DuckDB, etc. and only adds the connector's
// packages, pinned against python/constraints.txt so the shared ones never change version.

const installs = new Map<string, Promise<string>>();

function ensureEnvironment(
  info: ConnectorInfo,
  onProgress: (message: string) => void,
): Promise<string> {
  if (info.packages.length === 0) return Promise.resolve(pythonExe);
  let install = installs.get(info.id);
  if (!install) {
    install = prepareEnvironment(info, onProgress).finally(() =>
      installs.delete(info.id),
    );
    installs.set(info.id, install);
  }
  return install;
}

async function prepareEnvironment(
  info: ConnectorInfo,
  onProgress: (message: string) => void,
) {
  const envDir = path.join(app.getPath('userData'), 'connector-envs', info.id);
  const envPython =
    process.platform === 'win32'
      ? path.join(envDir, 'Scripts', 'python.exe')
      : path.join(envDir, 'bin', 'python3');
  const constraintsPath = path.join(pythonRoot, 'constraints.txt');
  const constraints = await fs
    .readFile(constraintsPath, 'utf8')
    .catch(() => '');

  // Rebuild when the app's Python moves (e.g. after an update) or the pinned packages change.
  const stamp = createHash('sha256')
    .update([pythonExe, ...info.packages, constraints].join('\n'))
    .digest('hex');
  const stampPath = path.join(envDir, '.pawpaw-stamp');
  if ((await fs.readFile(stampPath, 'utf8').catch(() => '')) === stamp)
    return envPython;

  onProgress(
    `Downloading the ${info.name} connector. This only happens the first time…`,
  );
  await fs.rm(envDir, { recursive: true, force: true, maxRetries: 5 });
  // Without its own pip: it uses the bundled pip through the shared packages, which is newer
  // than the one Python's venv would install and supports --uploaded-prior-to.
  await runProcess(pythonExe, [
    ...PYTHON_FLAGS,
    '-m',
    'venv',
    '--system-site-packages',
    '--without-pip',
    envDir,
  ]);
  await runProcess(
    envPython,
    [
      ...PYTHON_FLAGS,
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-input',
      '--no-warn-script-location',
      // The connector's own dependencies aren't locked, so at least hold them to the project's
      // rule: only releases that have been public for 14 days.
      '--uploaded-prior-to',
      'P14D',
      ...(constraints ? ['-c', constraintsPath] : []),
      ...info.packages,
    ],
    (line) => {
      const match =
        /^(Collecting|Downloading|Installing collected packages)\s*:?\s*(\S+)?/.exec(
          line,
        );
      if (match) onProgress(`${match[1]} ${match[2] ?? ''}`.trim());
    },
  );
  await fs.writeFile(stampPath, stamp);
  return envPython;
}

/** Stops a process and anything it started (pip's own subprocesses, for example). */
function killTree(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
      windowsHide: true,
    });
  } else {
    proc.kill('SIGKILL');
  }
}

/**
 * Lets the current background task stop `proc` (see background.ts). Returns whether it was
 * stopped that way, and a function to call once it has exited.
 */
function stoppable(proc: ChildProcess) {
  const state = { stopped: false };
  const release = work.onCancel(() => {
    state.stopped = true;
    killTree(proc);
  });
  return { state, release };
}

/** Runs a command to completion; rejects with the end of its output if it fails. */
function runProcess(
  command: string,
  args: string[],
  onLine?: (line: string) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, { windowsHide: true, env: pythonEnv() });
    const { state, release } = stoppable(proc);
    const tail: string[] = [];
    const collect = (line: string) => {
      tail.push(line);
      if (tail.length > 20) tail.shift();
      onLine?.(line.trim());
    };
    readline.createInterface({ input: proc.stdout }).on('line', collect);
    readline.createInterface({ input: proc.stderr }).on('line', collect);
    proc.on('error', reject);
    proc.on('close', (code) => {
      release();
      if (state.stopped) reject(new CancelledError());
      else if (code === 0) resolve();
      else
        reject(
          new Error(
            `Downloading the connector failed:\n${tail.slice(-6).join('\n')}`,
          ),
        );
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Running connector jobs

const runningJobs = new Set<string>();

/** What a load says once its data has arrived (DataProgress.received). */
const RECEIVED = 'Data loaded, now processing…';

/** Loads (by source ID, or ALL_SOURCES) whose data has arrived: data:stop leaves them alone. */
const processing = new Set<string>();

function sendProgress(progress: DataProgress) {
  if (progress.received) processing.add(progress.sourceId);
  else processing.delete(progress.sourceId);
  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send('data:progress', progress);
}

/** Ways to stop each source's running connector process, by source ID (see stopLoad). */
const jobStoppers = new Map<string, () => void>();

/**
 * Stops a source's load from outside its background task (the assistant's Stop), unless its
 * data has already arrived. The load then fails with "Stopped.".
 */
export function stopLoad(id: string) {
  if (!processing.has(id)) jobStoppers.get(id)?.();
}

/** Runs a load, tracking whether it can still be stopped. */
async function stopUntilReceived<T>(id: string, operation: () => Promise<T>) {
  processing.delete(id);
  try {
    return await operation();
  } finally {
    processing.delete(id);
  }
}

function runJob<T>(
  python: string,
  job: Record<string, unknown>,
  onProgress: (message: string, received?: boolean) => void,
  stopKey?: string,
) {
  const project = openProject();
  return new Promise<T>((resolve, reject) => {
    const proc = spawn(
      python,
      [...PYTHON_FLAGS, path.join(sidecarDir, 'runner.py')],
      {
        windowsHide: true,
        // Each project keeps its own dlt pipeline state.
        env: pythonEnv(path.join(app.getPath('userData'), 'dlt', project.id)),
      },
    );
    const { state, release } = stoppable(proc);
    if (stopKey) {
      jobStoppers.set(stopKey, () => {
        state.stopped = true;
        killTree(proc);
      });
    }
    let outcome: { ok: true; value: T } | { ok: false; error: Error } | null =
      null;
    const stderr: string[] = [];

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.event === 'progress')
        onProgress(
          event.received ? RECEIVED : event.message,
          event.received === true,
        );
      else if (event.event === 'result')
        outcome = { ok: true, value: event.result };
      else if (event.event === 'error') {
        console.error(`[connector] ${event.detail}`);
        outcome = { ok: false, error: new Error(event.message) };
      }
    });
    readline.createInterface({ input: proc.stderr }).on('line', (line) => {
      stderr.push(line);
      if (stderr.length > 20) stderr.shift();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      release();
      if (stopKey) jobStoppers.delete(stopKey);
      if (state.stopped) reject(new CancelledError());
      else if (outcome?.ok) resolve(outcome.value);
      else if (outcome) reject(outcome.error);
      else
        reject(
          new Error(
            `The connector stopped unexpectedly (exit code ${code}).\n${stderr.slice(-3).join('\n')}`,
          ),
        );
    });
    // Settings (including secrets) go over stdin, never on the command line.
    proc.stdin.end(JSON.stringify(job) + '\n');
  });
}

/** Runs a job for a source, with its saved settings and secrets. */
async function runSourceJob<T>(
  id: string,
  job: Record<string, unknown>,
  onProgress = (message: string, received?: boolean) =>
    sendProgress({ sourceId: id, message, received }),
): Promise<T> {
  if (runningJobs.has(id)) throw new Error('This data source is already busy.');
  runningJobs.add(id);
  try {
    const source = await readSource(id);
    const info = await connector(source.type);
    const python = await ensureEnvironment(info, onProgress);
    const settings = {
      ...source.options,
      ...(await readSecrets(openProject().id, id)),
    };
    return await runJob<T>(
      python,
      { ...job, connector: info.id, settings },
      onProgress,
      id,
    );
  } finally {
    runningJobs.delete(id);
  }
}

/** Loads a source's tables, without rebuilding anything that depends on them. */
async function loadSource(
  id: string,
  resources: string[],
  onProgress?: (message: string, received?: boolean) => void,
): Promise<LoadedTable[]> {
  const others = (await readAllSources()).filter((s) => s.id !== id);
  const transformedNames = Object.keys((await readTransformed()).tables);
  const result = await runSourceJob<{ tables: LoadedTable[] }>(
    id,
    {
      action: 'load',
      resources,
      data_dir: dataDir(),
      pipeline_name: `pawpaw_${id}`,
      reserved_tables: [
        ...others.flatMap((s) => s.tables),
        ...transformedNames,
      ],
    },
    onProgress,
  );

  // Tables this source loaded last time but no longer produces are removed.
  const source = await readSource(id);
  const tables = result.tables.map((t) => t.name);
  await removeTables(source.tables.filter((t) => !tables.includes(t)));
  await writeSource({
    ...source,
    resources,
    tables,
    lastLoadedAt: new Date().toISOString(),
  });
  return result.tables;
}

/** Finds the tables a source can load. */
export const discover = (id: string) =>
  runSourceJob<DiscoveredResource[]>(id, { action: 'discover' });

/** load, tracking whether it can still be stopped (data:stop, stopLoad). */
export const loadStoppable = (id: string, resources: string[]) =>
  stopUntilReceived(id, () => load(id, resources));

/** Loads one source, then re-applies transforms and rebuilds transformed tables. */
export async function load(
  id: string,
  resources: string[],
): Promise<LoadedTable[]> {
  const loaded = await loadSource(id, resources);
  const { inPlaceErrors } = await rebuildDerived(() =>
    sendProgress({ sourceId: id, message: RECEIVED, received: true }),
  );
  return loaded.map((t) =>
    inPlaceErrors[t.name] ? { ...t, transformError: inPlaceErrors[t.name] } : t,
  );
}

/** Loads every source in turn, then re-applies transforms and rebuilds transformed tables once. */
export async function refreshAll(): Promise<RefreshAllResult> {
  const sources = await readAllSources();
  const failedSources: RefreshAllResult['failedSources'] = [];
  // Once any source's data has arrived, Refresh all can't be stopped: the rebuild must follow.
  let receivedAny = false;
  const progress = (message: string, received?: boolean) => {
    receivedAny ||= received === true;
    sendProgress({ sourceId: ALL_SOURCES, message, received: receivedAny });
  };
  for (const [i, source] of sources.entries()) {
    work.checkCancelled();
    const prefix = `${source.name} (${i + 1} of ${sources.length})`;
    progress(`${prefix}: starting…`);
    try {
      await loadSource(source.id, source.resources, (message, received) =>
        progress(`${prefix}: ${message}`, received),
      );
    } catch (error) {
      work.checkCancelled(); // Stopped, rather than failed: don't carry on.
      failedSources.push({
        name: source.name,
        error: (error as Error).message,
      });
    }
  }
  const { inPlaceErrors, transformedErrors } = await rebuildDerived(() =>
    progress(RECEIVED, true),
  );
  return {
    sourceCount: sources.length,
    failedSources,
    failedTables: Object.entries({
      ...inPlaceErrors,
      ...transformedErrors,
    }).map(([name, error]) => ({
      name,
      error,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Model diagram (model/diagram.json)

/** Keeps only well-formed table positions, rounded to whole pixels. */
function cleanDiagram(value: unknown): ModelDiagram {
  const tables: ModelDiagram['tables'] = {};
  const raw = (value as ModelDiagram | null)?.tables;
  if (raw && typeof raw === 'object') {
    for (const [table, position] of Object.entries(raw)) {
      if (
        SAFE_TABLE.test(table) &&
        Number.isFinite(position?.x) &&
        Number.isFinite(position?.y)
      ) {
        tables[table] = {
          x: Math.round(position.x),
          y: Math.round(position.y),
        };
      }
    }
  }
  return { tables };
}

const loadDiagram = () => readJson(diagramPath(), cleanDiagram);

async function saveDiagram(diagram: ModelDiagram) {
  await writeJson(diagramPath(), cleanDiagram(diagram));
  await markProjectChanged();
}

// ---------------------------------------------------------------------------------------------
// SQL transforms (see python/sidecar/transforms.py). Two kinds:
//   in-place transforms of loaded tables: model/transforms.json, results in data/model/<table>
//   transformed tables built from other tables: model/transformed.json, results in
//   data/transformed/<table>
// In-place transforms read loaded tables' original data, so they never depend on each other.
// Transformed tables read the tables as currently shown, so they're built in dependency order
// (src/shared/dependencies.ts) after the in-place transforms.

export interface TransformsFile {
  tables: Record<string, { sql: string; updatedAt: string }>;
}

/** Keeps only well-formed transforms of safely named tables. */
export function cleanTransforms(value: unknown): TransformsFile {
  const tables: TransformsFile['tables'] = {};
  const raw = (value as TransformsFile | null)?.tables;
  for (const [table, t] of Object.entries(raw ?? {})) {
    const transform = t as { sql?: unknown; updatedAt?: unknown };
    if (SAFE_TABLE.test(table) && typeof transform?.sql === 'string') {
      tables[table] = {
        sql: transform.sql,
        updatedAt: String(transform.updatedAt ?? ''),
      };
    }
  }
  return { tables };
}

export const readTransforms = () => readJson(transformsPath(), cleanTransforms);

async function writeTransforms(transforms: TransformsFile) {
  await writeJson(transformsPath(), transforms);
  await markProjectChanged();
}

export async function applyTransform(table: string, sql: string) {
  if (!SAFE_TABLE.test(table)) throw new Error('Invalid table name.');
  // Run it first, so a failing query is never saved.
  const result = await callPython<{ rows: number }>('apply_transform', {
    data_dir: dataDir(),
    table,
    sql,
  });
  const transforms = await readTransforms();
  transforms.tables[table] = { sql, updatedAt: new Date().toISOString() };
  await writeTransforms(transforms);
  await rebuildDownstream([table]);
  return result;
}

export async function removeTransform(table: string) {
  if (!SAFE_TABLE.test(table)) throw new Error('Invalid table name.');
  await callPython('remove_transform', { data_dir: dataDir(), table });
  const transforms = await readTransforms();
  delete transforms.tables[table];
  await writeTransforms(transforms);
  await rebuildDownstream([table]);
}

/** Re-runs every in-place transform. Returns an error message per failed table. */
async function reapplyTransforms(): Promise<Record<string, string>> {
  const transforms = (await readTransforms()).tables;
  const loaded = new Set(
    await callPython<string[]>('list_tables', { data_dir: dataDir() }),
  );
  const errors: Record<string, string> = {};
  for (const [table, transform] of Object.entries(transforms)) {
    work.checkCancelled();
    if (!loaded.has(table)) continue;
    try {
      await callPython('apply_transform', {
        data_dir: dataDir(),
        table,
        sql: transform.sql,
      });
    } catch (error) {
      work.checkCancelled();
      errors[table] = (error as Error).message;
      // Don't leave the previous result over the new data: show the original until it's fixed.
      // The query itself stays saved so it can be edited.
      await callPython('remove_transform', {
        data_dir: dataDir(),
        table,
      }).catch(() => {});
    }
  }
  return errors;
}

// --- Transformed tables ----------------------------------------------------------------------

interface TransformedFile {
  tables: Record<
    string,
    {
      sql: string;
      dependsOn: string[];
      updatedAt: string;
      error: string | null;
    }
  >;
}

/** Keeps only well-formed transformed tables with safe names. */
export function cleanTransformed(value: unknown): TransformedFile {
  const tables: TransformedFile['tables'] = {};
  const raw = (value as TransformedFile | null)?.tables;
  for (const [table, t] of Object.entries(raw ?? {})) {
    const def = t as {
      sql?: unknown;
      dependsOn?: unknown;
      updatedAt?: unknown;
      error?: unknown;
    };
    if (!SAFE_TABLE.test(table) || typeof def?.sql !== 'string') continue;
    tables[table] = {
      sql: def.sql,
      dependsOn: Array.isArray(def.dependsOn)
        ? def.dependsOn.filter((d): d is string => typeof d === 'string')
        : [],
      updatedAt: String(def.updatedAt ?? ''),
      error: typeof def.error === 'string' ? def.error : null,
    };
  }
  return { tables };
}

const readTransformed = () => readJson(transformedPath(), cleanTransformed);

async function writeTransformed(file: TransformedFile) {
  await writeJson(transformedPath(), file);
  await markProjectChanged();
}

const dependencyMap = (file: TransformedFile): DependencyMap =>
  Object.fromEntries(
    Object.entries(file.tables).map(([name, t]) => [name, t.dependsOn]),
  );

/**
 * Rebuilds transformed tables, which must be in build order. A table whose query fails, or that
 * reads one that failed, has its old result removed and the error recorded.
 */
async function rebuildTransformed(
  names: string[],
  onProgress?: (message: string) => void,
): Promise<Record<string, string>> {
  const file = await readTransformed();
  const errors: Record<string, string> = {};
  for (const [i, name] of names.entries()) {
    work.checkCancelled();
    const def = file.tables[name];
    if (!def) continue;
    onProgress?.(`Building ${name} (${i + 1} of ${names.length})…`);
    try {
      const failed = def.dependsOn.find((d) => d in errors);
      if (failed)
        throw new Error(`It reads ${failed}, which couldn't be built.`);
      await callPython('build_table', {
        data_dir: dataDir(),
        table: name,
        sql: def.sql,
      });
      def.error = null;
    } catch (error) {
      work.checkCancelled();
      errors[name] = def.error = (error as Error).message;
      await callPython('clear_table', {
        data_dir: dataDir(),
        table: name,
      }).catch(() => {});
    }
  }
  if (names.length) await writeTransformed(file);
  return errors;
}

/** Re-applies every in-place transform, then rebuilds every transformed table in order. */
export async function rebuildDerived(onProgress?: (message: string) => void) {
  onProgress?.('Applying transforms…');
  const inPlaceErrors = await reapplyTransforms();

  const file = await readTransformed();
  const { order, blocked } = buildOrder(dependencyMap(file));
  const transformedErrors = await rebuildTransformed(order, onProgress);
  if (blocked.length) {
    const latest = await readTransformed();
    for (const name of blocked) {
      transformedErrors[name] = latest.tables[name].error =
        'It’s part of a circular reference.';
      await callPython('clear_table', {
        data_dir: dataDir(),
        table: name,
      }).catch(() => {});
    }
    await writeTransformed(latest);
  }
  await refreshDatasets(onProgress);
  return { inPlaceErrors, transformedErrors };
}

/** Rebuilds the transformed tables that read any of `changed`, in order, then the report's data. */
async function rebuildDownstream(changed: string[]) {
  const file = await readTransformed();
  const errors = await rebuildTransformed(
    downstreamOf(dependencyMap(file), changed),
  );
  await refreshDatasets();
  return errors;
}

export async function saveTransformed(
  input: SaveTransformedInput,
): Promise<{ rows: number }> {
  const name = input.name.trim();
  if (!NAME.test(name)) {
    throw new Error(`${NAME_RULE} For example sales_by_region.`);
  }
  const file = await readTransformed();
  const loaded = await callPython<string[]>('list_tables', {
    data_dir: dataDir(),
  });
  if (input.isNew && (name in file.tables || loaded.includes(name))) {
    throw new Error(`There's already a table called ${name}.`);
  }
  if (!input.isNew && !(name in file.tables))
    throw new Error(`There's no transformed table called ${name}.`);

  const dependsOn = await callPython<string[]>('query_tables', {
    data_dir: dataDir(),
    sql: input.sql,
    kind: 'transformed',
  });
  const deps = { ...dependencyMap(file), [name]: dependsOn };
  const cycle = findCycle(deps, name);
  if (cycle) {
    throw new Error(
      cycle.length === 2
        ? 'A table can’t read itself.'
        : `That would make a circular reference: ${cycle.join(' → ')}.`,
    );
  }

  // Build it first, so a failing query is never saved.
  const result = await callPython<{ rows: number }>('build_table', {
    data_dir: dataDir(),
    table: name,
    sql: input.sql,
  });
  file.tables[name] = {
    sql: input.sql,
    dependsOn,
    updatedAt: new Date().toISOString(),
    error: null,
  };
  await writeTransformed(file);
  await rebuildDownstream([name]);
  return result;
}

export async function listTransformed(): Promise<TransformedTable[]> {
  const file = await readTransformed();
  return Object.entries(file.tables).map(([name, t]) => ({ name, ...t }));
}

// --- Deleting tables -------------------------------------------------------------------------

/** Transformed tables and in-place transforms of other tables that read any of `tables`. */
export async function dependentsOf(tables: string[]): Promise<string[]> {
  const deps = dependencyMap(await readTransformed());
  const users = new Set(tables.flatMap((t) => directDependents(deps, t)));
  for (const [table, transform] of Object.entries(
    (await readTransforms()).tables,
  )) {
    if (tables.includes(table)) continue;
    const reads = await callPython<string[]>('query_tables', {
      data_dir: dataDir(),
      sql: transform.sql,
    }).catch(() => []);
    if (reads.some((r) => tables.includes(r))) users.add(table);
  }
  for (const t of tables) users.delete(t);
  return [...users].sort();
}

/**
 * What deleting a table removes: the table, and for a loaded table its nested child tables
 * (parent__child) too, and the source that loaded it (whose list of tables changes).
 */
export async function deletion(table: string) {
  if (!SAFE_TABLE.test(table)) throw new Error('Invalid table name.');
  const transformed = await readTransformed();
  if (table in transformed.tables) {
    return { doomed: [table], transformed, owner: undefined };
  }
  const owner = (await readAllSources()).find((s) => s.tables.includes(table));
  const doomed = [
    table,
    ...(owner?.tables ?? []).filter((t) => t.startsWith(`${table}__`)),
  ];
  return { doomed, transformed, owner };
}

/**
 * Deletes a table, with its transform and (unless `keepLayout`) its place on the Model data
 * canvas. A loaded table's nested child tables go too. Refused while other tables read it.
 */
export async function deleteTable(table: string, { keepLayout = false } = {}) {
  const { doomed, transformed, owner } = await deletion(table);

  const users = await dependentsOf(doomed);
  if (users.length) {
    throw new Error(
      `${users.join(', ')} ${users.length === 1 ? 'uses' : 'use'} this table. Change or delete ${users.length === 1 ? 'it' : 'them'} first.`,
    );
  }

  if (table in transformed.tables) {
    await callPython('clear_table', { data_dir: dataDir(), table });
    delete transformed.tables[table];
    await writeTransformed(transformed);
  } else {
    for (const t of doomed)
      await callPython('delete_table', { data_dir: dataDir(), table: t });
    if (owner)
      await writeSource({
        ...owner,
        tables: owner.tables.filter((t) => !doomed.includes(t)),
      });
    const transforms = await readTransforms();
    for (const t of doomed) delete transforms.tables[t];
    await writeTransforms(transforms);
  }
  if (keepLayout) return;
  const diagram = await loadDiagram();
  for (const t of doomed) delete diagram.tables[t];
  await saveDiagram(diagram);
}

// --- Matching data to the project's files ----------------------------------------------------

/** Each source's loaded tables, by source ID. */
export async function sourceTables(): Promise<Record<string, string[]>> {
  return Object.fromEntries(
    (await readAllSources()).map((s) => [s.id, s.tables]),
  );
}

async function folderNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && SAFE_TABLE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * After the project's files were put back as they were (undoing the assistant's changes), removes
 * the data nothing accounts for any more: tables of sources that are gone or no longer list them
 * (`before` is sourceTables() from before), gone sources' saved secrets, in-place results whose
 * transform is gone, and transformed tables no longer defined. The caller then rebuilds.
 */
export async function removeUnaccountedData(before: Record<string, string[]>) {
  const after = await sourceTables();
  const owned = new Set(Object.values(after).flat());
  await removeTables(
    Object.values(before)
      .flat()
      .filter((t) => !owned.has(t)),
  );
  for (const id of Object.keys(before)) {
    if (!(id in after)) await deleteSecrets(openProject().id, id);
  }
  const transforms = (await readTransforms()).tables;
  for (const table of await folderNames(path.join(dataDir(), 'model'))) {
    if (!(table in transforms))
      await removePath(path.join(dataDir(), 'model', table));
  }
  const transformed = (await readTransformed()).tables;
  for (const table of await folderNames(path.join(dataDir(), 'transformed'))) {
    if (!(table in transformed))
      await removePath(path.join(dataDir(), 'transformed', table));
  }
}

// ---------------------------------------------------------------------------------------------
// IPC

async function pickPaths(
  event: IpcMainInvokeEvent,
  kind: 'file' | 'files' | 'folder',
  filters: ConnectorField['fileFilters'] = [],
): Promise<string[]> {
  const win = BrowserWindow.fromWebContents(event.sender)!;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties:
      kind === 'folder'
        ? ['openDirectory']
        : kind === 'files'
          ? ['openFile', 'multiSelections']
          : ['openFile'],
    filters: filters.map((f) => ({ name: f.name, extensions: f.extensions })),
  });
  return canceled ? [] : filePaths;
}

export function registerDataHandlers() {
  ipcMain.handle('data:catalog', () => catalog());
  ipcMain.handle('data:list-sources', async () =>
    Promise.all((await readAllSources()).map(toDataSource)),
  );
  ipcMain.handle('data:save-source', (_event, input: SaveSourceInput) =>
    tracked('Saving a data source', () => saveSource(input)),
  );
  ipcMain.handle('data:remove-source', (_event, id: string) =>
    tracked('Removing a data source', () => removeSource(id)),
  );
  // Connecting and loading are keyed by the source's ID, and Refresh all by ALL_SOURCES, so
  // data:stop can stop one of them.
  ipcMain.handle('data:discover', (_event, id: string) =>
    tracked('Connecting to a data source', () => discover(id), id),
  );
  ipcMain.handle('data:load', (_event, id: string, resources: string[]) =>
    tracked('Loading data', () => loadStoppable(id, resources), id),
  );
  ipcMain.handle('data:stop', (_event, id: string) => {
    if (!processing.has(String(id))) work.stop(openProject().id, String(id));
  });
  ipcMain.handle('data:list-tables', () =>
    callPython<string[]>('list_tables', {
      data_dir: dataDir(),
    }),
  );
  ipcMain.handle('data:describe-tables', () =>
    callPython<TableSchema[]>('describe_tables', {
      data_dir: dataDir(),
    }),
  );
  ipcMain.handle(
    'data:get-transform',
    async (_event, table: string) =>
      (await readTransforms()).tables[table]?.sql ?? null,
  );
  ipcMain.handle(
    'data:preview-transform',
    (_event, sql: string, kind: TableKind = 'loaded') =>
      callPython<TablePreview>('preview_transform', {
        data_dir: dataDir(),
        sql,
        kind,
        limit: 200,
      }),
  );
  ipcMain.handle('data:list-transformed', () => listTransformed());
  ipcMain.handle(
    'data:save-transformed',
    (_event, input: SaveTransformedInput) =>
      tracked('Building a transformed table', () => saveTransformed(input)),
  );
  ipcMain.handle('data:refresh-all', () =>
    tracked(
      'Refreshing all data',
      () => stopUntilReceived(ALL_SOURCES, refreshAll),
      ALL_SOURCES,
    ),
  );
  ipcMain.handle('data:apply-transform', (_event, table: string, sql: string) =>
    tracked('Applying a transform', () => applyTransform(table, sql)),
  );
  ipcMain.handle('data:remove-transform', (_event, table: string) =>
    tracked('Removing a transform', () => removeTransform(table)),
  );
  ipcMain.handle('data:delete-table', (_event, table: string) =>
    tracked('Deleting a table', () => deleteTable(table)),
  );
  ipcMain.handle('data:load-diagram', () => loadDiagram());
  ipcMain.handle('data:save-diagram', (_event, diagram: ModelDiagram) =>
    tracked('Saving the layout', () => saveDiagram(diagram)),
  );
  ipcMain.handle('data:preview-table', (_event, table: string, limit = 100) =>
    callPython<TablePreview>('preview_table', {
      data_dir: dataDir(),
      table,
      limit,
    }),
  );
  ipcMain.handle('data:pick-paths', pickPaths);
}
