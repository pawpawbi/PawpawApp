// Checking the data source settings the assistant gives (src/assistant/source-input.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changedSettings,
  checkSettings,
  describeSettings,
  missingSettings,
} from '../../src/assistant/source-input.ts';
import type { ConnectorField } from '../../src/shared/types.ts';

const field = (
  key: string,
  type: ConnectorField['type'],
  extra: Partial<ConnectorField> = {},
): ConnectorField => ({
  key,
  label: key[0].toUpperCase() + key.slice(1),
  type,
  required: false,
  secret: false,
  help: '',
  placeholder: '',
  default: null,
  options: [],
  fileFilters: [],
  advanced: false,
  ...extra,
});

const FIELDS = [
  field('host', 'text', { required: true }),
  field('port', 'number'),
  field('ssl', 'checkbox'),
  field('mode', 'select', {
    options: [
      { value: 'fast', label: 'Fast' },
      { value: 'safe', label: 'Safe' },
    ],
  }),
  field('paths', 'files'),
  field('password', 'password', { required: true, secret: true }),
];

test('settings are checked against the fields and cleaned', () => {
  assert.deepEqual(
    checkSettings(FIELDS, {
      host: ' db.example.com ',
      port: '5432',
      ssl: true,
      mode: 'safe',
      paths: [' a.csv '],
    }),
    {
      host: 'db.example.com',
      port: 5432,
      ssl: true,
      mode: 'safe',
      paths: ['a.csv'],
    },
  );
  assert.deepEqual(checkSettings(FIELDS, undefined), {});
  assert.deepEqual(checkSettings(FIELDS, { port: null }), { port: '' });
});

test('secret, unknown and wrongly typed settings are refused', () => {
  assert.throws(
    () => checkSettings(FIELDS, { password: 'hunter2' }),
    /secret: the user types it into the source's form/,
  );
  assert.throws(() => checkSettings(FIELDS, { hots: 'x' }), /no setting/);
  assert.throws(() => checkSettings(FIELDS, { port: 'abc' }), /a number/);
  assert.throws(() => checkSettings(FIELDS, { ssl: 'yes' }), /true or false/);
  assert.throws(() => checkSettings(FIELDS, { mode: 'turbo' }), /one of/);
  assert.throws(() => checkSettings(FIELDS, { paths: 'a.csv' }), /list/);
  assert.throws(() => checkSettings(FIELDS, ['host']), /must be an object/);
});

test('missing settings: plain ones by value, secret ones by whether one is saved', () => {
  assert.deepEqual(
    missingSettings(FIELDS, { host: '' }, []).map((f) => f.key),
    ['host', 'password'],
  );
  assert.deepEqual(missingSettings(FIELDS, { host: 'x' }, ['password']), []);
});

test('changes and descriptions', () => {
  assert.deepEqual(
    changedSettings({ host: 'a', port: 1 }, { host: 'a', port: 2, ssl: true }),
    { port: 2, ssl: true },
  );
  assert.deepEqual(changedSettings({ host: 'a' }, { port: '' }), {});
  assert.equal(
    describeSettings(FIELDS, { host: 'db', paths: ['a', 'b'], port: '' }),
    'host db, paths a, b, no port',
  );
  const long = ['C:', 'Users', ...Array(30).fill('deep'), 'sales.csv'].join(
    '/',
  );
  assert.ok(long.length > 120);
  const described = describeSettings(FIELDS, { paths: [long] });
  assert.ok(described.length < 130);
  assert.ok(described.endsWith('sales.csv'), 'the file name stays visible');
});
