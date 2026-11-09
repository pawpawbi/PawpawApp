// Refresh schedules of published projects (src/shared/schedule.ts): checking them, when they
// run (in local time) and describing them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkSchedule,
  cleanStoredSchedule,
  dayOfMonth,
  describeSchedule,
  isDue,
  nextRun,
  previousRun,
} from '../../src/shared/schedule.ts';
import type { RefreshSchedule } from '../../src/shared/types.ts';

/** A local date and time. */
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min);

test('schedules are checked, sorted and cleaned of repeats', () => {
  assert.deepEqual(
    checkSchedule({
      repeat: 'weekly',
      days: [0, 3, 1, 3],
      times: ['18:00', '06:00', '06:00'],
    }),
    { repeat: 'weekly', days: [1, 3, 0], times: ['06:00', '18:00'] },
  );
  assert.deepEqual(
    checkSchedule({
      repeat: 'monthly',
      days: [-1, 15, 1, -10],
      times: ['00:00'],
    }),
    { repeat: 'monthly', days: [1, 15, -1, -10], times: ['00:00'] },
  );
  // Days that don't exist for the kind are dropped; with none left, it's refused.
  assert.deepEqual(
    checkSchedule({
      repeat: 'monthly',
      days: [0, 32, -11, 2.5, 3],
      times: ['09:30'],
    }).days,
    [3],
  );
  assert.throws(
    () => checkSchedule({ repeat: 'weekly', days: [7], times: ['06:00'] }),
    /at least one day of the week/,
  );
  assert.throws(
    () =>
      checkSchedule({ repeat: 'monthly', days: [1], times: ['24:00', '6:00'] }),
    /at least one time/,
  );
  assert.throws(
    () => checkSchedule({ repeat: 'daily', days: [1], times: ['06:00'] }),
    /weekly or monthly/,
  );
  const tooMany = Array.from(
    { length: 25 },
    (_, i) => `${String(i % 24).padStart(2, '0')}:${i < 24 ? '00' : '30'}`,
  );
  assert.throws(
    () => checkSchedule({ repeat: 'weekly', days: [1], times: tooMany }),
    /at most 24/,
  );
  // A bad saved one is dropped rather than refused.
  assert.equal(
    cleanStoredSchedule({ repeat: 'weekly', days: [], times: [] }),
    undefined,
  );
  assert.equal(cleanStoredSchedule(null), undefined);
});

test('days of the month count from the start or the end, and stop at its last day', () => {
  assert.equal(dayOfMonth(1, 30), 1);
  assert.equal(dayOfMonth(31, 30), 30);
  assert.equal(dayOfMonth(31, 28), 28);
  assert.equal(dayOfMonth(-1, 30), 30);
  assert.equal(dayOfMonth(-1, 28), 28);
  assert.equal(dayOfMonth(-10, 31), 22);
  assert.equal(dayOfMonth(-10, 28), 19);
});

test('weekly schedules run on their days at each time', () => {
  // Monday and Thursday at 06:00 and 18:00. 9 November 2026 is a Monday.
  const s: RefreshSchedule = {
    repeat: 'weekly',
    days: [1, 4],
    times: ['06:00', '18:00'],
  };
  assert.deepEqual(nextRun(s, at(2026, 11, 9, 5, 59)), at(2026, 11, 9, 6));
  assert.deepEqual(nextRun(s, at(2026, 11, 9, 6)), at(2026, 11, 9, 18));
  assert.deepEqual(nextRun(s, at(2026, 11, 9, 18)), at(2026, 11, 12, 6));
  assert.deepEqual(nextRun(s, at(2026, 11, 13)), at(2026, 11, 16, 6));
  assert.deepEqual(previousRun(s, at(2026, 11, 9, 6)), at(2026, 11, 9, 6));
  assert.deepEqual(previousRun(s, at(2026, 11, 9, 5)), at(2026, 11, 5, 18));
  assert.deepEqual(previousRun(s, at(2026, 11, 11, 12)), at(2026, 11, 9, 18));
});

test('monthly schedules run on days from the start and the end of each month', () => {
  // The 1st, the 31st (the last day of shorter months) and the last day: once each day.
  const s: RefreshSchedule = {
    repeat: 'monthly',
    days: [1, 31, -1],
    times: ['07:00'],
  };
  assert.deepEqual(nextRun(s, at(2026, 11, 9)), at(2026, 11, 30, 7));
  assert.deepEqual(nextRun(s, at(2026, 11, 30, 7)), at(2026, 12, 1, 7));
  assert.deepEqual(nextRun(s, at(2027, 2, 2)), at(2027, 2, 28, 7));
  assert.deepEqual(nextRun(s, at(2028, 2, 2)), at(2028, 2, 29, 7));
  // Ten days from the end: 22 December, 19 February.
  const late: RefreshSchedule = {
    repeat: 'monthly',
    days: [-10],
    times: ['23:30'],
  };
  assert.deepEqual(nextRun(late, at(2026, 12, 1)), at(2026, 12, 22, 23, 30));
  assert.deepEqual(nextRun(late, at(2027, 2, 1)), at(2027, 2, 19, 23, 30));
  assert.deepEqual(previousRun(late, at(2027, 2, 1)), at(2027, 1, 22, 23, 30));
});

test('a refresh is due once a scheduled time has passed since the last one done', () => {
  const s: RefreshSchedule = { repeat: 'weekly', days: [1], times: ['06:00'] };
  const now = at(2026, 11, 9, 8);
  // Set after Monday's 06:00: not due until next Monday.
  assert.equal(isDue(s, at(2026, 11, 9, 7).toISOString(), now), null);
  // Set before it (or last run before it): that 06:00 is due, once.
  assert.deepEqual(
    isDue(s, at(2026, 11, 9, 5).toISOString(), now),
    at(2026, 11, 9, 6),
  );
  // Missed several Mondays while PawpawBI wasn't running: only the latest is due.
  assert.deepEqual(
    isDue(s, at(2026, 10, 1).toISOString(), now),
    at(2026, 11, 9, 6),
  );
  assert.equal(isDue(s, at(2026, 11, 9, 6).toISOString(), now), null);
});

test('schedules are described in words', () => {
  assert.equal(
    describeSchedule({
      repeat: 'weekly',
      days: [1, 4],
      times: ['06:00', '18:00'],
    }),
    'Every Monday and Thursday at 06:00 and 18:00',
  );
  assert.equal(
    describeSchedule({
      repeat: 'weekly',
      days: [1, 2, 3, 4, 5, 6, 0],
      times: ['09:00'],
    }),
    'Every day at 09:00',
  );
  assert.equal(
    describeSchedule({
      repeat: 'monthly',
      days: [1, 2, 3, 11, 22, -1, -3],
      times: ['07:00'],
    }),
    'On the 1st, 2nd, 3rd, 11th, 22nd, last day and 3rd last day of each month at 07:00',
  );
});
