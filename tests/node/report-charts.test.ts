// The report site's chart library (src/report-template/assets/charts.js): its pure helpers, run
// in a bare VM context. Drawing is checked by eye. Arrays from the VM are copied ([...x]) before
// comparing, since deepEqual tells arrays from another context apart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('../../src/report-template/assets/charts.js', import.meta.url),
  'utf8',
);
const window: Record<string, any> = { addEventListener() {} };

// charts.js formats with the viewer's locale (Intl with no locale given). Pin it to en-US in
// the sandbox so the formatting assertions don't depend on this machine's settings.
const LOCALE = 'en-US';
const fixedLocale = (Format: any) =>
  function (_locale: unknown, options?: unknown) {
    return new Format(LOCALE, options);
  };
const fixedIntl = Object.create(Intl, {
  NumberFormat: { value: fixedLocale(Intl.NumberFormat) },
  DateTimeFormat: { value: fixedLocale(Intl.DateTimeFormat) },
});

vm.runInNewContext(source, {
  window,
  document: {
    currentScript: {
      src: 'https://reports.example.com/sales/assets/charts.js',
    },
    baseURI: 'https://reports.example.com/sales/pages/x.html',
    createElement: () => ({}),
    head: { prepend() {} },
  },
  URL,
  Intl: fixedIntl,
});
const { niceTicks, timeTicks, parseTime, formatValue, buildSeries, toRows } =
  window.pawpaw._internal;

test('dataset names are checked before anything is fetched', async () => {
  await assert.rejects(
    window.pawpaw.load('../secrets'),
    /isn't a dataset name/,
  );
  await assert.rejects(window.pawpaw.load('Sales'), /isn't a dataset name/);
});

test('ticks are round numbers covering the data', () => {
  assert.deepEqual([...niceTicks(0, 97, 5).ticks], [0, 20, 40, 60, 80, 100]);
  assert.deepEqual([...niceTicks(0, 1, 5).ticks], [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual([...niceTicks(-30, 45, 5).ticks], [-40, -20, 0, 20, 40, 60]);
  assert.deepEqual([...niceTicks(0, 0).ticks], [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual([...niceTicks(5, 5).ticks], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...niceTicks(NaN, 3).ticks], [0, 0.2, 0.4, 0.6, 0.8, 1]);
});

test('dates arrive as ISO text and are read as UTC', () => {
  assert.equal(parseTime('2024-03-01'), Date.UTC(2024, 2, 1));
  assert.equal(parseTime('2024-03-01T06:30:00'), Date.UTC(2024, 2, 1, 6, 30));
  assert.equal(parseTime('2024-03-01 06:30:00'), Date.UTC(2024, 2, 1, 6, 30));
  assert.equal(
    parseTime('2024-03-01T06:30:00+02:00'),
    Date.UTC(2024, 2, 1, 4, 30),
  );
  assert.ok(Number.isNaN(parseTime('March 2024')));
  assert.ok(Number.isNaN(parseTime(20240301)));
});

test('time ticks fall on round dates', () => {
  const months = timeTicks(Date.UTC(2023, 0, 15), Date.UTC(2024, 11, 20), 8);
  assert.equal(months.unit, 'month');
  for (const t of months.ticks) assert.equal(new Date(t).getUTCDate(), 1);
  assert.ok(months.ticks.length <= 8);

  const years = timeTicks(Date.UTC(2001, 5, 1), Date.UTC(2024, 0, 1), 6);
  assert.equal(years.unit, 'year');
  assert.deepEqual(
    [...years.ticks].map((t: number) => new Date(t).getUTCFullYear()),
    [2005, 2010, 2015, 2020],
  );
});

test('values are formatted, compactly on axes', () => {
  assert.equal(formatValue(null), '–');
  assert.equal(formatValue('North'), 'North');
  assert.equal(formatValue(1234.567), '1,234.57');
  assert.equal(formatValue(12900, null, { compact: true }), '12.9K');
  // 'auto' shortens from 10,000 (labels on the marks and headline numbers).
  assert.equal(formatValue(12900, null, { compact: 'auto' }), '12.9K');
  assert.equal(formatValue(9999, null, { compact: 'auto' }), '9,999');
  assert.equal(formatValue(0.255, 'percent'), '25.5%');
  assert.equal(formatValue(1234.5, 'currency'), '$1,234.50');
  assert.doesNotMatch(
    formatValue(0, 'currency', { compact: true }),
    /\.00/,
    'whole amounts on axes',
  );
  assert.equal(
    formatValue(3, (v: number) => `${v} things`),
    '3 things',
  );
});

const rows = (columns: string[], data: unknown[][]) =>
  toRows(
    columns.map((name) => ({ name })),
    data,
    false,
  );

test('series come from one column, several columns, or a series column', () => {
  const single = buildSeries(
    rows(
      ['region', 'sales'],
      [
        ['N', 1],
        ['S', 2],
      ],
    ),
    {},
  );
  assert.deepEqual([...single.keys], ['N', 'S']);
  assert.equal(single.series.length, 1);
  assert.equal(single.series[0].values.get('S'), 2);

  const wide = buildSeries(rows(['m', 'a', 'b'], [['Jan', 1, 2]]), {
    x: 'm',
    y: ['a', 'b'],
    labels: { b: 'Budget' },
  });
  assert.deepEqual(
    [...wide.series].map((s: { name: string }) => s.name),
    ['a', 'Budget'],
  );

  const long = buildSeries(
    rows(
      ['m', 'r', 'v'],
      [
        ['Jan', 'N', 1],
        ['Jan', 'S', 2],
        ['Feb', 'N', 3],
      ],
    ),
    { x: 'm', y: 'v', series: 'r' },
  );
  assert.deepEqual([...long.keys], ['Jan', 'Feb']);
  assert.equal(long.series[1].values.get('Feb'), undefined);
});

test('colours follow the series, in palette order', () => {
  const built = buildSeries(
    rows(
      ['m', 'r', 'v'],
      [
        ['Jan', 'B', 1],
        ['Jan', 'A', 2],
      ],
    ),
    { x: 'm', y: 'v', series: 'r' },
  );
  assert.deepEqual(
    [...built.series].map((s: { colour: string }) => s.colour),
    [...window.pawpaw.colours].slice(0, 2),
  );
});

test('more than eight series fold the smallest into "Other"', () => {
  const data = Array.from({ length: 10 }, (_, i) => ['Jan', `s${i}`, i + 1]);
  const built = buildSeries(rows(['m', 's', 'v'], data), {
    x: 'm',
    y: 'v',
    series: 's',
  });
  assert.equal(built.series.length, 8);
  assert.equal(built.folded, 3);
  assert.equal(built.series[7].name, 'Other');
  assert.equal(built.series[7].values.get('Jan'), 1 + 2 + 3);
});

test('a missing column says which columns there are', () => {
  assert.throws(
    () => buildSeries(rows(['region', 'sales'], []), { x: 'regon' }),
    /no column called "regon".*region, sales/,
  );
});
