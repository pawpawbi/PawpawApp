// Working folders and crash recovery (src/workspace.ts), with real .pawpaw files in a temp folder.
// A "crash" is simply not calling removeWorkspace: the working folder is left behind, as it
// would be if the app stopped unexpectedly.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { InvalidProjectFileError } from '../../src/pawpaw-archive.ts';
import {
  createWorkspace,
  markWorkspaceDirty,
  openWorkspace,
  removeWorkspace,
  saveWorkspace,
  workspacePaths,
  type Workspace,
  type WorkspaceState,
} from '../../src/workspace.ts';
import { writeJson } from '../../src/fs-json.ts';

const APP = 'PawpawBI test';
let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pawpaw-workspace-'));
  root = path.join(tmp, 'workspaces');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

/** Records whether recovery was offered, and answers it. */
function asker(answer: boolean) {
  const asked: { name: string; state: WorkspaceState }[] = [];
  return {
    asked,
    askToRecover: async (name: string, state: WorkspaceState) => {
      asked.push({ name, state });
      return answer;
    },
  };
}

const open = (filePath: string, answer = true) => {
  const ask = asker(answer);
  return openWorkspace(filePath, {
    root,
    appLabel: APP,
    askToRecover: ask.askToRecover,
  }).then((ws) => ({ ws, asked: ask.asked }));
};

const read = (ws: Workspace, file: string) =>
  fs.readFile(path.join(ws.filesDir, file), 'utf8');
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/** Makes an unsaved change the way the app does: write into the working folder, mark dirty. */
async function change(ws: Workspace, file: string, content: string) {
  await fs.mkdir(path.dirname(path.join(ws.filesDir, file)), {
    recursive: true,
  });
  await fs.writeFile(path.join(ws.filesDir, file), content);
  await markWorkspaceDirty(ws);
}

/** A saved project with one chat message, then an unsaved change, then a "crash". */
async function crashedProject() {
  const file = path.join(tmp, 'Sales report.pawpaw');
  const ws = await createWorkspace(file, { root, appLabel: APP });
  await change(ws, 'chat/messages.jsonl', '{"id":"m1","text":"saved"}\n');
  await saveWorkspace(ws, APP);
  await change(
    ws,
    'chat/messages.jsonl',
    '{"id":"m1","text":"saved"}\n{"id":"m2","text":"unsaved"}\n',
  );
  await change(
    ws,
    'model/transformed.json',
    '{"tables":{"by_region":{"sql":"SELECT 1"}}}',
  );
  return { file, ws };
}

test('a new project is created clean, with a file and a working folder', async () => {
  const file = path.join(tmp, 'New.pawpaw');
  const ws = await createWorkspace(file, { root, appLabel: APP });
  assert.equal(ws.dirty, false);
  assert.equal(ws.manifest.name, 'New');
  assert.ok(await exists(file));
  assert.equal(JSON.parse(await read(ws, 'manifest.json')).id, ws.manifest.id);
});

test('a new project includes its starting files in the saved file', async () => {
  const file = path.join(tmp, 'Started.pawpaw');
  const ws = await createWorkspace(file, {
    root,
    appLabel: APP,
    populate: async (filesDir, name) => {
      await fs.mkdir(path.join(filesDir, 'report'));
      await fs.writeFile(path.join(filesDir, 'report', 'index.html'), name);
    },
  });
  assert.equal(ws.dirty, false, 'nothing to save yet');
  await removeWorkspace(ws);

  const { ws: reopened } = await open(file);
  assert.equal(await read(reopened, 'report/index.html'), 'Started');
});

test('after a crash, Recover keeps the unsaved changes and they stay unsaved', async () => {
  const { file, ws: before } = await crashedProject();

  const { ws, asked } = await open(file, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].name, 'Sales report');
  assert.equal(asked[0].state.dirty, true);
  assert.equal(ws.dirty, true, 'recovered changes still need saving');
  assert.equal(ws.workspaceDir, before.workspaceDir);
  assert.match(await read(ws, 'chat/messages.jsonl'), /unsaved/);
  assert.match(await read(ws, 'model/transformed.json'), /by_region/);
});

test('after a crash, Discard opens the last saved version', async () => {
  const { file } = await crashedProject();

  const { ws, asked } = await open(file, false);
  assert.equal(asked.length, 1);
  assert.equal(ws.dirty, false);
  assert.doesNotMatch(await read(ws, 'chat/messages.jsonl'), /unsaved/);
  assert.match(await read(ws, 'chat/messages.jsonl'), /saved/);
  assert.equal(
    await exists(path.join(ws.filesDir, 'model', 'transformed.json')),
    false,
  );
});

test('Discard is final: reopening afterwards does not ask again', async () => {
  const { file } = await crashedProject();
  await open(file, false);
  const { asked } = await open(file, true);
  assert.equal(asked.length, 0);
});

test('recovered changes can then be saved, and reopening does not ask again', async () => {
  const { file } = await crashedProject();
  const { ws } = await open(file, true);
  await saveWorkspace(ws, APP);

  const { ws: again, asked } = await open(file, true);
  assert.equal(asked.length, 0);
  assert.match(
    await read(again, 'chat/messages.jsonl'),
    /unsaved/,
    'the recovered change was saved',
  );
});

test('no question when a leftover working folder has nothing unsaved', async () => {
  const file = path.join(tmp, 'Clean.pawpaw');
  const ws = await createWorkspace(file, { root, appLabel: APP });
  await fs.writeFile(path.join(ws.filesDir, 'stray.txt'), 'left over'); // not marked dirty
  // Crash: the working folder is left behind, but nothing was unsaved.

  const { ws: reopened, asked } = await open(file);
  assert.equal(asked.length, 0);
  assert.equal(reopened.dirty, false);
  assert.equal(
    await exists(path.join(reopened.filesDir, 'stray.txt')),
    false,
    'extracted afresh',
  );
});

test('no question after saving, even if the app then crashed', async () => {
  const file = path.join(tmp, 'Saved.pawpaw');
  const ws = await createWorkspace(file, { root, appLabel: APP });
  await change(ws, 'chat/messages.jsonl', '{"id":"m1"}\n');
  await saveWorkspace(ws, APP);
  // Crash after saving.

  const { ws: reopened, asked } = await open(file);
  assert.equal(asked.length, 0);
  assert.match(await read(reopened, 'chat/messages.jsonl'), /m1/);
});

test('copies of a project in different places never share unsaved changes', async () => {
  const { file } = await crashedProject();
  const copy = path.join(tmp, 'copies', 'Sales report.pawpaw');
  await fs.mkdir(path.dirname(copy), { recursive: true });
  await fs.copyFile(file, copy);

  // The copy has the same project ID but a different location: nothing to recover there.
  const { ws: copyWs, asked: copyAsked } = await open(copy, true);
  assert.equal(copyAsked.length, 0);
  assert.doesNotMatch(await read(copyWs, 'chat/messages.jsonl'), /unsaved/);

  // And opening the copy didn't disturb the original's unsaved changes.
  const { ws, asked } = await open(file, true);
  assert.equal(asked.length, 1);
  assert.match(await read(ws, 'chat/messages.jsonl'), /unsaved/);
  assert.notEqual(copyWs.workspaceDir, ws.workspaceDir);
});

for (const [label, content] of [
  ['unreadable JSON', '{not json'],
  ['missing dirty flag', '{"filePath":"x","updatedAt":"2026-10-17T00:00:00Z"}'],
  [
    'dirty as text',
    '{"filePath":"x","dirty":"true","updatedAt":"2026-10-17T00:00:00Z"}',
  ],
  ['empty file', ''],
]) {
  test(`a damaged recovery record (${label}) opens normally without asking`, async () => {
    const { file, ws } = await crashedProject();
    await fs.writeFile(path.join(ws.workspaceDir, 'state.json'), content);

    const { ws: reopened, asked } = await open(file, true);
    assert.equal(asked.length, 0);
    assert.equal(reopened.dirty, false);
    assert.doesNotMatch(await read(reopened, 'chat/messages.jsonl'), /unsaved/);
  });
}

test('damaged unsaved changes give a clear message, and Discard still works', async () => {
  const { file, ws } = await crashedProject();
  await fs.writeFile(path.join(ws.filesDir, 'manifest.json'), '{broken');

  await assert.rejects(open(file, true), (error: Error) => {
    assert.ok(error instanceof InvalidProjectFileError);
    assert.match(error.message, /choose Discard/);
    return true;
  });
  const { ws: discarded } = await open(file, false);
  assert.equal(discarded.dirty, false);
  assert.equal(discarded.manifest.name, 'Sales report');
});

test('closing normally removes the working folder, so nothing is offered next time', async () => {
  const { file, ws } = await crashedProject();
  await removeWorkspace(ws); // closed with "Don't save"
  assert.equal(await exists(ws.workspaceDir), false);

  const { ws: reopened, asked } = await open(file, true);
  assert.equal(asked.length, 0);
  assert.doesNotMatch(await read(reopened, 'chat/messages.jsonl'), /unsaved/);
});

test('a project renamed before the crash keeps its new name when recovered', async () => {
  const { file, ws } = await crashedProject();
  await writeJson(path.join(ws.filesDir, 'manifest.json'), {
    ...ws.manifest,
    name: 'Q3 sales',
  });

  const { ws: recovered, asked } = await open(file, true);
  assert.equal(asked[0].name, 'Sales report', 'asked using the saved name');
  assert.equal(recovered.manifest.name, 'Q3 sales');
});

test('marking dirty records it on disk only once', async () => {
  const file = path.join(tmp, 'Dirty.pawpaw');
  const ws = await createWorkspace(file, { root, appLabel: APP });
  assert.equal(await markWorkspaceDirty(ws), true);
  assert.equal(await markWorkspaceDirty(ws), false);
  const state = JSON.parse(
    await fs.readFile(path.join(ws.workspaceDir, 'state.json'), 'utf8'),
  );
  assert.equal(state.dirty, true);
  assert.equal(state.filePath, file);
});

test('an old-format JSON project opens as unsaved, so saving upgrades it to a ZIP', async () => {
  const file = path.join(tmp, 'Old.pawpaw');
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      name: 'Old',
      createdAt: '2026-01-01T00:00:00Z',
    }),
  );

  const { ws, asked } = await open(file);
  assert.equal(asked.length, 0);
  assert.equal(ws.dirty, true);
  await saveWorkspace(ws, APP);
  const header = (await fs.readFile(file)).subarray(0, 2).toString('latin1');
  assert.equal(header, 'PK', 'now a ZIP');
});

test('working folders are named by project ID and location', () => {
  const a = workspacePaths(root, 'abc123', path.join(tmp, 'a.pawpaw'));
  const b = workspacePaths(root, 'abc123', path.join(tmp, 'b.pawpaw'));
  assert.match(path.basename(a.workspaceDir), /^abc123-[0-9a-f]{8}$/);
  assert.notEqual(a.workspaceDir, b.workspaceDir);
  assert.equal(a.filesDir, path.join(a.workspaceDir, 'project'));
});
