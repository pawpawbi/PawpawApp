// Data source credentials (passwords, API keys, tokens), encrypted with the operating system's
// secure storage and kept on this computer only, never in the .pawpaw file.
// Stored at userData/credentials/<project id>/<source id>.bin. Next to each, <source id>.settings.json
// records the connector and non-secret settings the source was last saved or run with on this
// computer (see confirmSettings): a source only runs with the secrets saved here once its
// settings match, so a changed copy of a project can't point them at someone else's server.
import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, removePath, writeJson } from './fs-json';
import { SAFE_ID } from './shared/ids';

function credentialsPath(projectId: string, sourceId: string, suffix = '.bin') {
  // Both IDs become part of a path, so refuse anything that isn't a plain ID.
  if (!SAFE_ID.test(projectId) || !SAFE_ID.test(sourceId))
    throw new Error('Invalid ID.');
  return path.join(
    app.getPath('userData'),
    'credentials',
    projectId,
    `${sourceId}${suffix}`,
  );
}

export async function readSecrets(
  projectId: string,
  sourceId: string,
): Promise<Record<string, string>> {
  let encrypted: Buffer;
  try {
    encrypted = await fs.readFile(credentialsPath(projectId, sourceId));
  } catch {
    return {};
  }
  try {
    return JSON.parse(safeStorage.decryptString(encrypted));
  } catch {
    throw new Error(
      "The saved credentials for this source can't be read (they were saved by a different Windows account, or the file is damaged). Enter them again in the source's settings.",
    );
  }
}

export async function writeSecrets(
  projectId: string,
  sourceId: string,
  secrets: Record<string, string>,
) {
  const filePath = credentialsPath(projectId, sourceId);
  if (Object.keys(secrets).length === 0) {
    await removePath(filePath);
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "This computer's secure storage isn't available, so credentials can't be saved.",
    );
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    safeStorage.encryptString(JSON.stringify(secrets)),
  );
}

export async function deleteSecrets(projectId: string, sourceId: string) {
  await removePath(credentialsPath(projectId, sourceId));
  await removePath(credentialsPath(projectId, sourceId, '.settings.json'));
}

/** The connector and non-secret settings a source was confirmed with on this computer. */
export interface ConfirmedSettings {
  type: string;
  options: Record<string, unknown>;
}

function cleanConfirmed(raw: unknown): ConfirmedSettings | null {
  const c = raw as Partial<ConfirmedSettings> | null;
  return typeof c?.type === 'string' &&
    c.options !== null &&
    typeof c.options === 'object' &&
    !Array.isArray(c.options)
    ? { type: c.type, options: c.options }
    : null;
}

/** JSON with keys in order, so two settings compare the same however they were written. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const sameSettings = (a: ConfirmedSettings, b: ConfirmedSettings) =>
  stable(a) === stable(b);

/** The settings a source was last confirmed with here, or null if it never was. */
export const readConfirmedSettings = (projectId: string, sourceId: string) =>
  readJson(
    credentialsPath(projectId, sourceId, '.settings.json'),
    cleanConfirmed,
  );

/**
 * Records that the source's settings were entered or accepted on this computer, so it may run
 * with the secrets saved here (data.ts, `confirmSource`).
 */
export async function confirmSettings(
  projectId: string,
  sourceId: string,
  settings: ConfirmedSettings,
) {
  await writeJson(
    credentialsPath(projectId, sourceId, '.settings.json'),
    settings,
  );
}

/** Deletes every saved credential of a project, when the project is deleted. */
export async function deleteProjectSecrets(projectId: string) {
  if (!SAFE_ID.test(projectId)) throw new Error('Invalid ID.');
  await removePath(
    path.join(app.getPath('userData'), 'credentials', projectId),
  );
}
