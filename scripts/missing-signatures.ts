// Clears the signature entry in a Windows DLL's or EXE's header when the signature it points to
// isn't in the file. The bundled Python's stripped build has cut the signature off the end of a
// DLL (zlib1.dll) but left the entry: Windows loads it, but signing the Microsoft Store package
// fails on it with signtool error 0x800700C1. forge.config.mts runs this on the packaged copy of
// the bundled Python, so python/runtime stays as downloaded.
import fs from 'node:fs/promises';
import path from 'node:path';

const PE_FILE = /\.(dll|pyd|exe)$/i;

async function readAt(file: fs.FileHandle, position: number, length: number) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** Clears `file`'s signature entry if the signature isn't inside the file. True if it did. */
export async function clearMissingSignature(file: string): Promise<boolean> {
  const handle = await fs.open(file, 'r+');
  try {
    const dos = await readAt(handle, 0, 64);
    if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) return false; // "MZ"
    const pe = dos.readUInt32LE(0x3c);
    // The "PE\0\0" signature, the 20-byte file header, then the optional header, whose data
    // directories end it; the certificate table is directory 4.
    const header = await readAt(handle, pe, 24 + 112 + 5 * 8);
    if (header.length < 26 || header.readUInt32LE(0) !== 0x4550) return false;
    const magic = header.readUInt16LE(24);
    if (magic !== 0x10b && magic !== 0x20b) return false; // PE32, PE32+
    const wide = magic === 0x20b;
    const entry = 24 + (wide ? 112 : 96) + 4 * 8;
    if (
      header.length < entry + 8 ||
      header.readUInt16LE(20) < entry + 8 - 24 || // the optional header's size
      header.readUInt32LE(24 + (wide ? 108 : 92)) < 5 // how many directories it has
    )
      return false;
    const offset = header.readUInt32LE(entry);
    const size = header.readUInt32LE(entry + 4);
    if (offset === 0 && size === 0) return false;
    const { size: length } = await handle.stat();
    if (offset > 0 && size > 0 && offset + size <= length) return false;
    await handle.write(Buffer.alloc(8), 0, 8, pe + entry);
    return true;
  } finally {
    await handle.close();
  }
}

/** Runs clearMissingSignature on every DLL and EXE under `dir`; returns the ones it cleared. */
export async function clearMissingSignatures(dir: string): Promise<string[]> {
  const cleared: string[] = [];
  for (const name of await fs.readdir(dir, { recursive: true })) {
    if (
      PE_FILE.test(name) &&
      (await clearMissingSignature(path.join(dir, name)))
    )
      cleared.push(name);
  }
  return cleared;
}
