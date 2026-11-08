// Tests for small shared helpers.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { errorMessage } from '../../src/errors.ts';
import { plain } from '../../src/plain.ts';
import { newId } from '../../src/shared/ids.ts';

describe('newId', () => {
  test('is 8 lowercase letters and digits by default', () => {
    for (let i = 0; i < 200; i++) assert.match(newId(), /^[a-z0-9]{8}$/);
  });

  test('honours the requested length', () => {
    assert.match(newId(6), /^[a-z0-9]{6}$/);
    assert.match(newId(20), /^[a-z0-9]{20}$/);
    assert.equal(newId(0), '');
  });

  test('is random', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    assert.equal(ids.size, 1000);
  });
});

describe('errorMessage', () => {
  test("strips Electron's IPC prefix and the error class name", () => {
    const error = new Error(
      "Error invoking remote method 'data:load': Error: File not found: x.csv",
    );
    assert.equal(errorMessage(error), 'File not found: x.csv');
  });

  test('strips custom error class names too', () => {
    const error = new Error(
      "Error invoking remote method 'project:open': InvalidProjectFileError: This is not a PawpawBI project file.",
    );
    assert.equal(errorMessage(error), 'This is not a PawpawBI project file.');
  });

  test('strips the prefix when there is no error class name', () => {
    assert.equal(
      errorMessage(new Error("Error invoking remote method 'x': plain text")),
      'plain text',
    );
  });

  test('leaves ordinary messages alone', () => {
    assert.equal(
      errorMessage(new Error('Something broke: Error: inner')),
      'Something broke: Error: inner',
    );
  });

  test('accepts non-Error values', () => {
    assert.equal(errorMessage('just a string'), 'just a string');
    assert.equal(errorMessage(42), '42');
  });
});

describe('plain', () => {
  test('returns a deep copy of plain data', () => {
    const value = { a: 1, nested: { list: [1, 'two', null] } };
    const copy = plain(value);
    assert.deepEqual(copy, value);
    assert.notEqual(copy, value);
    assert.notEqual(copy.nested, value.nested);
  });

  test('strips proxies so the result can be structured-cloned', () => {
    const proxy = new Proxy({ a: 1 }, {});
    assert.deepEqual(structuredClone(plain(proxy)), { a: 1 });
  });
});
