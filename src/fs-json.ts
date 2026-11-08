// Reading and writing the project's small JSON files. No Electron imports.
import fs from 'node:fs/promises';
import path from 'node:path';

/** Writes `value` as indented JSON, creating the folder if needed. */
export async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Reads a JSON file and passes it through `clean`, which keeps only what's well-formed (the
 * file may come from someone else's project). A missing or unreadable file gives `clean`
 * nothing, so it returns its empty shape.
 */
export async function readJson<T>(
  filePath: string,
  clean: (raw: unknown) => T,
): Promise<T> {
  let raw: unknown = null;
  try {
    raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    // Not there yet, or damaged: start from nothing.
  }
  return clean(raw);
}

/** Deletes a file or folder, retrying while antivirus briefly locks a freshly written file. */
export const removePath = (target: string) =>
  fs.rm(target, { recursive: true, force: true, maxRetries: 5 });
