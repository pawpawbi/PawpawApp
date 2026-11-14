// The Microsoft Store build's start-up task (src/startup-task.ts): finding its key in what
// `reg query` prints, and reading whether it's on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskKey, taskOn } from '../../src/startup-task.ts';

const BASE =
  'HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\SystemAppData';
const STORE = `${BASE}\\12345Publisher.PawpawBI_abcdefgh12345\\PawpawBIStartup`;
const TRIED = `${BASE}\\PawpawBI.PawpawBI_3mkv5mvgp1sd4\\PawpawBIStartup`;
const found = (...keys: string[]) =>
  `\r\n${keys.join('\r\n')}\r\n\r\nEnd of search: ${keys.length} match(es) found.\r\n`;

test("the start-up task's key is the running package's, or the only one", () => {
  const installed =
    'C:\\Program Files\\WindowsApps\\12345Publisher.PawpawBI_0.9.0.0_x64__abcdefgh12345\\app\\PawpawBI.exe';
  assert.equal(taskKey(found(TRIED, STORE), installed), STORE);
  assert.equal(
    taskKey(found(TRIED), 'C:\\somewhere\\app\\PawpawBI.exe'),
    TRIED,
  );
  assert.equal(
    taskKey(found(TRIED, STORE), 'C:\\somewhere\\PawpawBI.exe'),
    null,
  );
  assert.equal(taskKey(found(), installed), null);
});

test('the start-up task is on when Windows says enabled, by the user or by policy', () => {
  const state = (value: string) =>
    `\r\n${STORE}\r\n    State    REG_DWORD    ${value}\r\n\r\n`;
  assert.equal(taskOn(state('0x0')), false);
  assert.equal(taskOn(state('0x1')), false);
  assert.equal(taskOn(state('0x2')), true);
  assert.equal(taskOn(state('0x3')), false);
  assert.equal(taskOn(state('0x4')), true);
  assert.equal(taskOn(''), null);
});
