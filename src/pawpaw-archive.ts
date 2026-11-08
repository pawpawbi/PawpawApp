// Reading and writing .pawpaw archives (ZIP files). See docs/pawpaw-file-format.md.
// Deliberately free of Electron imports so it can be tested with plain Node.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';

export const MIMETYPE = 'application/vnd.pawpawbi.project+zip';

// Already-compressed formats are stored as-is: compressing them again only slows saving.
const STORED_EXTENSIONS = new Set([
  '.parquet',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.zip',
  '.gz',
]);

/** The file isn't a valid .pawpaw archive. The message is suitable to show the user. */
export class InvalidProjectFileError extends Error {}

/** True if the file starts with a ZIP local file header. */
export async function isZipFile(filePath: string): Promise<boolean> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    return bytesRead === 4 && header.readUInt32LE(0) === 0x04034b50;
  } finally {
    await handle.close();
  }
}

/** Extracts every entry except `mimetype` into destDir, which must exist. */
export async function extractArchive(
  filePath: string,
  destDir: string,
): Promise<void> {
  await withEntries(filePath, async (entry, zip) => {
    const target = safeTargetPath(destDir, entry.fileName);
    if (entry.fileName.endsWith('/')) {
      await fsp.mkdir(target, { recursive: true });
      return;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await pipeline(
      await openReadStream(zip, entry),
      fs.createWriteStream(target),
    );
  });
}

/** Reads one file from the archive as text. */
export async function readArchiveEntry(
  filePath: string,
  fileName: string,
): Promise<string> {
  let text: string | null = null;
  await withEntries(filePath, async (entry, zip) => {
    if (entry.fileName !== fileName) return;
    text = await readText(await openReadStream(zip, entry));
    return 'stop';
  });
  if (text === null)
    throw new InvalidProjectFileError(
      `The project file is missing ${fileName}.`,
    );
  return text;
}

/**
 * Zips srcDir into destPath, with `mimetype` first and uncompressed. Writes to a temporary
 * file and then replaces destPath, so a failed save never damages the existing file.
 */
export async function packArchive(
  srcDir: string,
  destPath: string,
): Promise<void> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(MIMETYPE, 'ascii'), 'mimetype', {
    compress: false,
    forceDosTimestamp: true,
  });
  for (const relativePath of await listFiles(srcDir)) {
    if (relativePath === 'mimetype') continue;
    zip.addFile(path.join(srcDir, ...relativePath.split('/')), relativePath, {
      compress: !STORED_EXTENSIONS.has(
        path.extname(relativePath).toLowerCase(),
      ),
    });
  }
  zip.end();

  const tempPath = `${destPath}.${process.pid}-${Date.now()}.tmp`;
  try {
    await pipeline(zip.outputStream, fs.createWriteStream(tempPath));
    await replaceFile(tempPath, destPath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * Opens the archive, checks the `mimetype` entry, then calls visit for every other entry in
 * order. visit can return 'stop' to finish early.
 */
async function withEntries(
  filePath: string,
  visit: (entry: yauzl.Entry, zip: yauzl.ZipFile) => Promise<'stop' | void>,
): Promise<void> {
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(filePath);
  } catch {
    throw new InvalidProjectFileError(
      'This is not a PawpawBI project file, or it is damaged.',
    );
  }
  try {
    const first = await nextEntry(zip);
    if (
      first?.fileName !== 'mimetype' ||
      (await readText(await openReadStream(zip, first))) !== MIMETYPE
    ) {
      throw new InvalidProjectFileError('This is not a PawpawBI project file.');
    }
    for (
      let entry = await nextEntry(zip);
      entry;
      entry = await nextEntry(zip)
    ) {
      if ((await visit(entry, zip)) === 'stop') break;
    }
  } finally {
    zip.close();
  }
}

/**
 * Resolves an entry name inside destDir, rejecting anything that could escape it
 * ("zip slip"). yauzl already rejects most of these; this is a second line of defence.
 */
function safeTargetPath(destDir: string, entryName: string): string {
  const unsafe =
    entryName.includes('\\') ||
    entryName.startsWith('/') ||
    /^[a-zA-Z]:/.test(entryName) ||
    entryName.split('/').includes('..');
  const root = path.resolve(destDir);
  const target = path.resolve(root, entryName);
  if (unsafe || !target.startsWith(root + path.sep)) {
    throw new InvalidProjectFileError(
      `The project file contains an unsafe path: ${entryName}`,
    );
  }
  return target;
}

/** All files under dir as sorted, forward-slash relative paths. */
/** Every file under a folder, as paths relative to it with forward slashes, sorted. */
export async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = prefix + entry.name;
    if (entry.isDirectory()) {
      files.push(
        ...(await listFiles(path.join(dir, entry.name), `${relativePath}/`)),
      );
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

/** Renames over an existing file, retrying briefly if antivirus or indexing has it locked. */
async function replaceFile(from: string, to: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? ''))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

// Promise wrappers around yauzl's callback API.

function openZip(filePath: string) {
  return new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      filePath,
      {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zip) => (error ? reject(error) : resolve(zip)),
    ),
  );
}

function nextEntry(zip: yauzl.ZipFile) {
  return new Promise<yauzl.Entry | null>((resolve, reject) => {
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    };
    const onEntry = (entry: yauzl.Entry) => (cleanup(), resolve(entry));
    const onEnd = () => (cleanup(), resolve(null));
    // yauzl reports malformed archives and unsafe entry names here.
    const onError = (error: Error) => (
      cleanup(),
      reject(
        new InvalidProjectFileError(
          `The project file is damaged (${error.message}).`,
        ),
      )
    );
    zip.on('entry', onEntry);
    zip.on('end', onEnd);
    zip.on('error', onError);
    zip.readEntry();
  });
}

function openReadStream(zip: yauzl.ZipFile, entry: yauzl.Entry) {
  return new Promise<Readable>((resolve, reject) =>
    zip.openReadStream(entry, (error, stream) =>
      error ? reject(error) : resolve(stream),
    ),
  );
}

async function readText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
