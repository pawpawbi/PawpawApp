// Clearing a DLL's header entry for a signature that isn't in the file
// (scripts/missing-signatures.ts), which the Store package's build does to the bundled Python.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  clearMissingSignature,
  clearMissingSignatures,
} from '../../scripts/missing-signatures.ts';

const PE = 0x80; // where the "PE\0\0" header starts

/** The certificate-table entry's place in a fake DLL. */
const entryAt = (wide: boolean) => PE + 24 + (wide ? 112 : 96) + 32;

/** A minimal DLL header whose signature entry is `offset`, `size`, padded to `length` bytes. */
function fakeDll(
  offset: number,
  size: number,
  { length = 1024, wide = true } = {},
) {
  const b = Buffer.alloc(length);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(PE, 0x3c);
  b.write('PE\0\0', PE, 'latin1');
  b.writeUInt16LE(wide ? 240 : 224, PE + 20); // the optional header's size
  b.writeUInt16LE(wide ? 0x20b : 0x10b, PE + 24);
  b.writeUInt32LE(16, PE + 24 + (wide ? 108 : 92)); // directories
  b.writeUInt32LE(offset, entryAt(wide));
  b.writeUInt32LE(size, entryAt(wide) + 4);
  return b;
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawpaw-signatures-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('an entry pointing past the end of the file is cleared, and nothing else changes', async () => {
  const dir = tempDir();
  for (const wide of [true, false]) {
    const file = path.join(dir, `missing-${wide}.dll`);
    // As in python-build-standalone's zlib1.dll: the signature would start where the file ends.
    const before = fakeDll(1024, 12064, { wide });
    fs.writeFileSync(file, before);
    assert.equal(await clearMissingSignature(file), true);
    const after = fs.readFileSync(file);
    assert.deepEqual(
      after.subarray(entryAt(wide), entryAt(wide) + 8),
      Buffer.alloc(8),
    );
    before.fill(0, entryAt(wide), entryAt(wide) + 8);
    assert.deepEqual(after, before);
  }
});

test('a signature that is in the file, or no signature, is left alone', async () => {
  const dir = tempDir();
  const cases = {
    'signed.dll': fakeDll(512, 512),
    'unsigned.dll': fakeDll(0, 0),
    'text.dll': Buffer.from('not a DLL at all'),
    'short.dll': Buffer.from('MZ'),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    assert.equal(await clearMissingSignature(file), false, name);
    assert.deepEqual(fs.readFileSync(file), bytes, name);
  }
});

test('every DLL, PYD and EXE in the folder is checked, including in subfolders', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'DLLs'));
  fs.writeFileSync(path.join(dir, 'DLLs', 'zlib1.dll'), fakeDll(1024, 100));
  fs.writeFileSync(path.join(dir, 'DLLs', '_ok.pyd'), fakeDll(512, 512));
  fs.writeFileSync(path.join(dir, 'python.exe'), fakeDll(2000, 8));
  fs.writeFileSync(path.join(dir, 'readme.txt'), fakeDll(1024, 100));
  assert.deepEqual((await clearMissingSignatures(dir)).sort(), [
    path.join('DLLs', 'zlib1.dll'),
    'python.exe',
  ]);
  // Not a DLL by name, so not touched.
  assert.equal(
    fs.readFileSync(path.join(dir, 'readme.txt')).readUInt32LE(entryAt(true)),
    1024,
  );
});
