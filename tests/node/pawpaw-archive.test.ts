// Tests for the .pawpaw archive format (docs/pawpaw-file-format.md).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { after, before, describe, test } from 'node:test';
import yauzl from 'yauzl';
import yazl from 'yazl';
import {
  extractArchive,
  InvalidProjectFileError,
  isZipFile,
  MIMETYPE,
  packArchive,
  readArchiveEntry,
} from '../../src/pawpaw-archive.ts';

const FILES: Record<string, string | Buffer> = {
  'manifest.json': JSON.stringify({
    formatVersion: 1,
    id: 'abc123',
    name: 'Test',
  }),
  'chat/messages.jsonl': '{"id":"m1","role":"user","text":"héllo – ünïcode"}\n',
  'data/raw/monthly_sales/1.parquet': Buffer.from([
    0x50, 0x41, 0x52, 0x31, 1, 2, 3, 0x50, 0x41, 0x52, 0x31,
  ]),
  'data/raw/Spëcial name/x.json': '{}',
  'thumbnail.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
  // A stray workspace "mimetype" file must not be written a second time.
  mimetype: 'should be ignored',
};

let work: string;

async function writeTree(dir: string, files: Record<string, string | Buffer>) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
}

/** Entry name -> compression method (0 = stored, 8 = deflate), in archive order. */
function compressionMethods(zipPath: string): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    const out: Record<string, number> = {};
    yauzl.open(zipPath, { lazyEntries: false }, (error, zip) => {
      if (error) return reject(error);
      zip.on(
        'entry',
        (entry: yauzl.Entry) => (out[entry.fileName] = entry.compressionMethod),
      );
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
    });
  });
}

async function writePlainZip(zipPath: string, entries: Record<string, string>) {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries))
    zip.addBuffer(Buffer.from(content), name);
  zip.end();
  await pipeline(zip.outputStream, fs.createWriteStream(zipPath));
}

before(async () => {
  work = await fsp.mkdtemp(path.join(os.tmpdir(), 'pawpaw-archive-test-'));
});

after(async () => {
  await fsp.rm(work, { recursive: true, force: true });
});

describe('packArchive', () => {
  let src: string;
  let zipPath: string;

  before(async () => {
    src = path.join(work, 'src');
    await writeTree(src, FILES);
    zipPath = path.join(work, 'Test.pawpaw');
    await packArchive(src, zipPath);
    await packArchive(src, zipPath); // saving again replaces the first file
  });

  test('writes a ZIP file', async () => {
    assert.equal(await isZipFile(zipPath), true);
  });

  test('puts mimetype first, uncompressed, readable at a fixed offset', async () => {
    const bytes = await fsp.readFile(zipPath);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.equal(
      bytes.readUInt16LE(8),
      0,
      'mimetype is stored, not compressed',
    );
    assert.equal(bytes.readUInt16LE(26), 'mimetype'.length);
    assert.equal(
      bytes.readUInt16LE(28),
      0,
      'no extra field, so the content starts at offset 38',
    );
    assert.equal(bytes.toString('ascii', 30, 38), 'mimetype');
    assert.equal(bytes.toString('ascii', 38, 38 + MIMETYPE.length), MIMETYPE);
  });

  test('stores parquet and png, deflates json and jsonl, and does not duplicate mimetype', async () => {
    const methods = await compressionMethods(zipPath);
    assert.deepEqual(Object.keys(methods), [
      'mimetype',
      'chat/messages.jsonl',
      'data/raw/monthly_sales/1.parquet',
      'data/raw/Spëcial name/x.json',
      'manifest.json',
      'thumbnail.png',
    ]);
    assert.equal(methods['mimetype'], 0);
    assert.equal(methods['data/raw/monthly_sales/1.parquet'], 0);
    assert.equal(methods['thumbnail.png'], 0);
    assert.equal(methods['manifest.json'], 8);
    assert.equal(methods['chat/messages.jsonl'], 8);
  });

  test('leaves no temporary files next to the destination', async () => {
    const leftovers = (await fsp.readdir(work)).filter((name) =>
      name.endsWith('.tmp'),
    );
    assert.deepEqual(leftovers, []);
  });

  test('round-trips every file byte for byte, including unicode names', async () => {
    const out = path.join(work, 'roundtrip');
    await fsp.mkdir(out);
    await extractArchive(zipPath, out);
    for (const [rel, content] of Object.entries(FILES)) {
      if (rel === 'mimetype') continue;
      assert.deepEqual(
        await fsp.readFile(path.join(out, ...rel.split('/'))),
        Buffer.from(content),
        rel,
      );
    }
    await assert.rejects(
      fsp.access(path.join(out, 'mimetype')),
      'mimetype is not extracted',
    );
  });

  test('readArchiveEntry reads one file as text', async () => {
    assert.equal(
      JSON.parse(await readArchiveEntry(zipPath, 'manifest.json')).name,
      'Test',
    );
    assert.equal(
      await readArchiveEntry(zipPath, 'chat/messages.jsonl'),
      FILES['chat/messages.jsonl'],
    );
  });

  test('readArchiveEntry reports a missing file', async () => {
    await assert.rejects(
      readArchiveEntry(zipPath, 'nope.json'),
      (error: unknown) => {
        assert.ok(error instanceof InvalidProjectFileError);
        assert.match(error.message, /missing nope\.json/);
        return true;
      },
    );
  });

  test('packs an empty project as just mimetype', async () => {
    const empty = path.join(work, 'empty-src');
    await fsp.mkdir(empty);
    const emptyZip = path.join(work, 'empty.pawpaw');
    await packArchive(empty, emptyZip);
    assert.deepEqual(Object.keys(await compressionMethods(emptyZip)), [
      'mimetype',
    ]);
  });
});

describe('extractArchive rejects bad files', () => {
  test('an entry named "../" (zip slip) is refused and nothing is written outside', async () => {
    const evilSrc = path.join(work, 'evil-src');
    await writeTree(evilSrc, { 'aa/evil.txt': 'pwned' });
    const evilZip = path.join(work, 'evil.pawpaw');
    await packArchive(evilSrc, evilZip);
    // Patch the entry name in both headers: "aa/evil.txt" -> "../evil.txt" (same length).
    const patched = (await fsp.readFile(evilZip))
      .toString('latin1')
      .replaceAll('aa/evil.txt', '../evil.txt');
    await fsp.writeFile(evilZip, Buffer.from(patched, 'latin1'));

    const out = path.join(work, 'evil-out', 'nested');
    await fsp.mkdir(out, { recursive: true });
    await assert.rejects(extractArchive(evilZip, out), InvalidProjectFileError);
    await assert.rejects(fsp.access(path.join(work, 'evil-out', 'evil.txt')));
  });

  test('an ordinary ZIP without the mimetype entry is refused', async () => {
    const plainZip = path.join(work, 'plain.zip');
    await writePlainZip(plainZip, { 'readme.txt': 'hi' });
    const out = path.join(work, 'plain-out');
    await fsp.mkdir(out);
    await assert.rejects(extractArchive(plainZip, out), (error: unknown) => {
      assert.ok(error instanceof InvalidProjectFileError);
      assert.match(error.message, /not a PawpawBI project/);
      return true;
    });
  });

  test('a ZIP whose mimetype has the wrong value is refused', async () => {
    const wrongZip = path.join(work, 'wrong-mimetype.zip');
    await writePlainZip(wrongZip, {
      mimetype: 'application/epub+zip',
      'manifest.json': '{}',
    });
    const out = path.join(work, 'wrong-out');
    await fsp.mkdir(out);
    await assert.rejects(
      extractArchive(wrongZip, out),
      /not a PawpawBI project/,
    );
  });

  test('a file that is not a ZIP is refused', async () => {
    const notZip = path.join(work, 'notzip.pawpaw');
    await fsp.writeFile(notZip, '{"version":1,"name":"Old"}');
    const out = path.join(work, 'notzip-out');
    await fsp.mkdir(out);
    await assert.rejects(extractArchive(notZip, out), InvalidProjectFileError);
  });
});

describe('isZipFile', () => {
  test('detects a legacy JSON project as not a ZIP', async () => {
    const legacy = path.join(work, 'legacy.pawpaw');
    await fsp.writeFile(legacy, '{"version":1,"name":"Old"}');
    assert.equal(await isZipFile(legacy), false);
  });

  test('handles files shorter than the ZIP signature', async () => {
    const tiny = path.join(work, 'tiny.pawpaw');
    await fsp.writeFile(tiny, 'PK');
    assert.equal(await isZipFile(tiny), false);
  });
});
