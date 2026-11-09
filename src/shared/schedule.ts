// Refresh schedules of published projects (RefreshSchedule in types.ts): checking them, when
// they run, and describing them. All in this computer's local time. Shared by the main process
// (src/scheduled-refresh.ts) and the Published projects screen; tested in tests/node.
import type { RefreshSchedule } from './types';

/** At most this many times a day, to keep schedules sensible. */
export const MAX_TIMES = 24;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Weekdays in the order the screen shows them (Monday first), as Date.getDay() numbers. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export const dayName = (day: number) => DAY_NAMES[day];

const validDay = (repeat: RefreshSchedule['repeat'], day: number) =>
  Number.isInteger(day) &&
  (repeat === 'weekly'
    ? day >= 0 && day <= 6
    : (day >= 1 && day <= 31) || (day >= -10 && day <= -1));

/**
 * A schedule from the page or the saved list, checked. Throws a message saying what's wrong,
 * for the page; cleanStoredSchedule drops a bad saved one instead.
 */
export function checkSchedule(value: unknown): RefreshSchedule {
  const s = (value ?? {}) as Partial<RefreshSchedule>;
  if (s.repeat !== 'weekly' && s.repeat !== 'monthly') {
    throw new Error('Choose whether it repeats weekly or monthly.');
  }
  const repeat = s.repeat;
  const days = [...new Set(Array.isArray(s.days) ? s.days : [])]
    .map(Number)
    .filter((d) => validDay(repeat, d));
  if (!days.length) {
    throw new Error(
      repeat === 'weekly'
        ? 'Choose at least one day of the week.'
        : 'Choose at least one day of the month.',
    );
  }
  const times = [...new Set(Array.isArray(s.times) ? s.times : [])].filter(
    (t): t is string => typeof t === 'string' && TIME.test(t),
  );
  if (!times.length) throw new Error('Add at least one time.');
  if (times.length > MAX_TIMES) {
    throw new Error(`Use at most ${MAX_TIMES} times a day.`);
  }
  return {
    repeat,
    days: days.sort((a, b) => sortKey(repeat, a) - sortKey(repeat, b)),
    times: times.sort(),
  };
}

/** A saved schedule, or undefined if it isn't valid. */
export function cleanStoredSchedule(
  value: unknown,
): RefreshSchedule | undefined {
  try {
    return value ? checkSchedule(value) : undefined;
  } catch {
    return undefined;
  }
}

/** Weekdays Monday first; month days in order, then those counted from the end. */
function sortKey(repeat: RefreshSchedule['repeat'], day: number) {
  if (repeat === 'weekly') return WEEKDAYS.indexOf(day);
  return day > 0 ? day : 100 - day;
}

const daysInMonth = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();

/** The day of the month a schedule's day means in a month of `length` days. */
export function dayOfMonth(day: number, length: number) {
  return day > 0 ? Math.min(day, length) : Math.max(1, length + day + 1);
}

/** Whether the schedule runs on `date`'s day. */
export function runsOn(schedule: RefreshSchedule, date: Date) {
  if (schedule.repeat === 'weekly')
    return schedule.days.includes(date.getDay());
  const length = daysInMonth(date);
  return schedule.days.some((d) => dayOfMonth(d, length) === date.getDate());
}

/** The times `date`'s day runs at, as local dates, earliest first. */
function runsThatDay(schedule: RefreshSchedule, date: Date): Date[] {
  if (!runsOn(schedule, date)) return [];
  return schedule.times.map((time) => {
    const [, hours, minutes] = TIME.exec(time)!;
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      Number(hours),
      Number(minutes),
    );
  });
}

/** Every schedule has a run within this many days of any date (a monthly one, the 31st). */
const LOOK_DAYS = 62;

const day = (from: Date, offset: number) =>
  new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);

/** The latest time the schedule ran at or before `now`, or null if there's none in reach. */
export function previousRun(schedule: RefreshSchedule, now: Date): Date | null {
  for (let offset = 0; offset <= LOOK_DAYS; offset++) {
    const runs = runsThatDay(schedule, day(now, -offset)).filter(
      (run) => run <= now,
    );
    if (runs.length) return runs[runs.length - 1];
  }
  return null;
}

/** The next time the schedule runs after `now`. */
export function nextRun(schedule: RefreshSchedule, now: Date): Date | null {
  for (let offset = 0; offset <= LOOK_DAYS; offset++) {
    const run = runsThatDay(schedule, day(now, offset)).find((r) => r > now);
    if (run) return run;
  }
  return null;
}

/** Whether a scheduled refresh is due: a run has passed since `doneUntil`. */
export function isDue(
  schedule: RefreshSchedule,
  doneUntil: string | undefined,
  now: Date,
): Date | null {
  const run = previousRun(schedule, now);
  if (!run) return null;
  const done = doneUntil ? Date.parse(doneUntil) : Number.NaN;
  return Number.isNaN(done) || run.getTime() > done ? run : null;
}

/** 1st, 2nd, 3rd, 4th… */
export function ordinal(n: number) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** A schedule day of the month, in words: "1st", "last day", "3rd last day". */
export function monthDayLabel(day: number) {
  if (day > 0) return ordinal(day);
  return day === -1 ? 'last day' : `${ordinal(-day)} last day`;
}

/** "a, b and c" */
function list(items: string[]) {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The schedule in words, e.g. "Every Monday and Thursday at 06:00 and 18:00". */
export function describeSchedule(schedule: RefreshSchedule) {
  const at = `at ${list(schedule.times)}`;
  if (schedule.repeat === 'weekly') {
    if (schedule.days.length === 7) return `Every day ${at}`;
    return `Every ${list(schedule.days.map(dayName))} ${at}`;
  }
  return `On the ${list(schedule.days.map(monthDayLabel))} of each month ${at}`;
}
