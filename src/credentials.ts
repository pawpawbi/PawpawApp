// Data source credentials (passwords, API keys, tokens), encrypted with the operating system's
// secure storage and kept on this computer only, never in the .pawpaw file.
// Stored at userData/credentials/<project id>/<source id>.bin.
import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { removePath } from './fs-json';
import { SAFE_ID } from './shared/ids';

function credentialsPath(projectId: string, sourceId: string) {
  // Both IDs become part of a path, so refuse anything that isn't a plain ID.
  if (!SAFE_ID.test(projectId) || !SAFE_ID.test(sourceId))
    throw new Error('Invalid ID.');
  return path.join(
    app.getPath('userData'),
    'credentials',
    projectId,
    `${sourceId}.bin`,
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
}

/** Deletes every saved credential of a project, when the project is deleted. */
export async function deleteProjectSecrets(projectId: string) {
  if (!SAFE_ID.test(projectId)) throw new Error('Invalid ID.');
  await removePath(
    path.join(app.getPath('userData'), 'credentials', projectId),
  );
}
