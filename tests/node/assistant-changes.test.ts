// The assistant's change journal (src/assistant/changes.ts): recording, rolling back a failed
// change, undo back to a point, and warning about files edited since.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { ChangeJournal } from '../../src/assistant/changes.ts';

let tmp: string;
let root: string;
let journal: ChangeJournal;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pawpaw-changes-'));
  root = path.join(tmp, 'project');
  await fs.mkdir(path.join(root, 'report', 'pages'), { recursive: true });
  await fs.mkdir(path.join(root, 'report', 'data'), { recursive: true });
  await fs.mkdir(path.join(root, 'model'), { recursive: true });
  await write('report/report.json', '{"pages":[]}');
  await write('report/data/big.json', 'data');
  journal = new ChangeJournal(root, path.join(tmp, 'undo'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

const write = async (relative: string, content: string) => {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), content);
};
const read = (relative: string) =>
  fs.readFile(path.join(root, relative), 'utf8').catch(() => null);
const site = { dir: 'report', exclude: ['data'] };

test('a change is recorded and undone, including files it created', async () => {
  const { record } = await journal.record('Added a page', [site], async () => {
    await write('report/report.json', '{"pages":["a"]}');
    await write('report/pages/a.html', '<h1>A</h1>');
  });
  assert.equal(record.summary, 'Added a page');
  assert.equal(await read('report/pages/a.html'), '<h1>A</h1>');

  await journal.undoBackTo(record.id);
  assert.equal(await read('report/report.json'), '{"pages":[]}');
  assert.equal(
    await read('report/pages/a.html'),
    null,
    'the created page is removed',
  );
  assert.equal((await journal.list())[0].undone, true);
});

test('files a change deleted come back on undo', async () => {
  await write('report/pages/a.html', '<h1>A</h1>');
  const { record } = await journal.record('Deleted a page', [site], () =>
    fs.rm(path.join(root, 'report/pages/a.html')),
  );
  await journal.undoBackTo(record.id);
  assert.equal(await read('report/pages/a.html'), '<h1>A</h1>');
});

test('a failed change is put back at once and not recorded', async () => {
  await assert.rejects(
    journal.record('Broke things', [site], async () => {
      await write('report/report.json', 'half written');
      await write('report/pages/new.html', 'x');
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await read('report/report.json'), '{"pages":[]}');
  assert.equal(await read('report/pages/new.html'), null);
  assert.deepEqual(await journal.list(), []);
});

test('undo back to a change reverts it and every later one, newest first', async () => {
  const first = await journal.record('One', [site], () =>
    write('report/report.json', '1'),
  );
  const second = await journal.record('Two', [site], () =>
    write('report/report.json', '2'),
  );
  const third = await journal.record(
    'Three',
    [{ file: 'model/datasets.json' }],
    () => write('model/datasets.json', '{}'),
  );

  const undone = await journal.undoBackTo(second.record.id);
  assert.deepEqual(
    undone.map((c) => c.summary),
    ['Two', 'Three'],
  );
  assert.equal(await read('report/report.json'), '1');
  assert.equal(await read('model/datasets.json'), null);
  assert.deepEqual(
    (await journal.list()).map((c) => [c.summary, c.undone]),
    [
      ['One', false],
      ['Two', true],
      ['Three', true],
    ],
  );
  await assert.rejects(
    journal.undoBackTo(third.record.id),
    /already been undone/,
  );
  assert.ok(first);
});

test('excluded folders are left alone', async () => {
  const { record } = await journal.record('Page and data', [site], async () => {
    await write('report/report.json', 'changed');
    await write('report/data/big.json', 'changed outside the change');
  });
  await journal.undoBackTo(record.id);
  assert.equal(await read('report/report.json'), '{"pages":[]}');
  assert.equal(
    await read('report/data/big.json'),
    'changed outside the change',
  );
});

test('files edited since the change are reported before undoing', async () => {
  const { record } = await journal.record('Wrote a page', [site], () =>
    write('report/pages/a.html', 'by the assistant'),
  );
  assert.deepEqual(await journal.conflicts(record.id), []);
  await write('report/pages/a.html', 'edited by the user');
  assert.deepEqual(await journal.conflicts(record.id), ['report/pages/a.html']);
});

test('the record survives reopening the journal', async () => {
  const { record } = await journal.record('One', [site], () =>
    write('report/report.json', '1'),
  );
  const reopened = new ChangeJournal(root, path.join(tmp, 'undo'));
  assert.equal((await reopened.list())[0].id, record.id);
  await reopened.undoBackTo(record.id);
  assert.equal(await read('report/report.json'), '{"pages":[]}');
});

test('file names with spaces are fine', async () => {
  const { record } = await journal.record('Logo', [site], () =>
    write('report/assets/my logo.png', 'png'),
  );
  await journal.undoBackTo(record.id);
  assert.equal(await read('report/assets/my logo.png'), null);
});

test('paths outside the project are refused', async () => {
  await assert.rejects(
    journal.record('Escape', [{ file: '../outside.txt' }], async () => {}),
    /Invalid path/,
  );
});

test('a journal opened after its store was deleted lists nothing', async () => {
  const { record } = await journal.record('One', [site], () =>
    write('report/report.json', '1'),
  );
  await fs.rm(path.join(tmp, 'undo'), { recursive: true, force: true });
  const reopened = new ChangeJournal(root, path.join(tmp, 'undo'));
  assert.deepEqual(await reopened.list(), []);
  await assert.rejects(reopened.undoBackTo(record.id), /isn't in the record/);
  assert.equal(await read('report/report.json'), '1', 'nothing was touched');
});

test('a missing saved copy means nothing is undone, not half of it', async () => {
  const { record } = await journal.record('Page', [site], async () => {
    await write('report/report.json', '{"pages":["a"]}');
    await write('report/pages/a.html', '<h1>A</h1>');
  });
  // The copy of report.json is lost, but the record still says to delete a.html.
  await fs.rm(path.join(tmp, 'undo', record.id, 'report', 'report.json'));
  await assert.rejects(journal.undoBackTo(record.id));
  assert.equal(await read('report/pages/a.html'), '<h1>A</h1>', 'not deleted');
  assert.equal(await read('report/report.json'), '{"pages":["a"]}');
  assert.equal((await journal.list())[0].undone, false);
});

test('undoing several changes records each one as it is done', async () => {
  const first = await journal.record('One', [site], () =>
    write('report/report.json', '1'),
  );
  await journal.record('Two', [{ file: 'model/datasets.json' }], () =>
    write('model/datasets.json', '{}'),
  );
  // Make the first change's copy unreadable, so the second undoes but the first fails.
  await fs.rm(path.join(tmp, 'undo', first.record.id), {
    recursive: true,
    force: true,
  });
  await assert.rejects(journal.undoBackTo(first.record.id));
  const reopened = new ChangeJournal(root, path.join(tmp, 'undo'));
  assert.deepEqual(
    (await reopened.list()).map((c) => [c.summary, c.undone]),
    [
      ['One', false],
      ['Two', true],
    ],
    'the journal on disk says exactly what happened',
  );
  assert.equal(await read('model/datasets.json'), null);
  assert.equal(await read('report/report.json'), '1');
});

test('files lists everything undoing back to a change would put back', async () => {
  const first = await journal.record('Wrote a', [site], () =>
    write('report/pages/a.html', 'A'),
  );
  await journal.record('Wrote b and data', [{ dir: 'report' }], async () => {
    await write('report/pages/b.html', 'B');
    await write('report/data/big.json', 'rebuilt');
  });
  assert.deepEqual(await journal.files(first.record.id), [
    'report/data/big.json',
    'report/pages/a.html',
    'report/pages/b.html',
  ]);
});

test('files the app rebuilds are never reported as edited since', async () => {
  const rebuilding = new ChangeJournal(root, path.join(tmp, 'undo'), {
    rebuilt: (file) => file.startsWith('report/data/'),
  });
  const { record } = await rebuilding.record(
    'Saved a dataset',
    [{ file: 'report/data/big.json' }, { file: 'model/datasets.json' }],
    async () => {
      await write('report/data/big.json', 'by the assistant');
      await write('model/datasets.json', '{}');
    },
  );
  await write('report/data/big.json', 'rewritten by a refresh');
  await write('model/datasets.json', '{"edited": true}');
  assert.deepEqual(await rebuilding.conflicts(record.id), [
    'model/datasets.json',
  ]);
});
