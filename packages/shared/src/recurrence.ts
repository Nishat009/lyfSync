import { addDays, weekdayOf } from "./time";

export const RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/** How a task repeats. Weekdays use 0 = Sunday. */
export interface Recurrence {
  frequency: RecurrenceFrequency;
  /** Every N days / weeks / months / years. */
  interval: number;
  /** Weekly only: the days it happens on. Empty means "same weekday as the first occurrence". */
  byWeekday: number[];
  /** Monthly only: day of the month (1-31). Null means "same day as the first occurrence"; clamped to short months. */
  byMonthday: number | null;
  /** Last date an occurrence may fall on. */
  endsOn: string | null;
  /** Maximum number of occurrences in total. */
  maxCount: number | null;
}

export const WEEKDAYS_MON_FRI = [1, 2, 3, 4, 5];

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [y, m, d];
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Days from `a` to `b` (both YYYY-MM-DD). */
function diffDays(a: string, b: string): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Start of the Sunday-based week containing `date`. */
function weekStart(date: string): string {
  return addDays(date, -weekdayOf(date));
}

function clampedDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
}

/**
 * The first occurrence strictly after `after`, or null when the series has ended.
 * `anchor` is the series' first date: it fixes which weeks, months or years count for intervals above 1.
 */
export function nextOccurrence(rule: Recurrence, anchor: string, after: string): string | null {
  const n = Math.max(1, rule.interval);
  let next: string | null = null;

  if (rule.frequency === "daily") {
    // Stay on the series grid so a late completion does not shift the schedule.
    const gap = Math.max(0, diffDays(anchor, after));
    next = addDays(anchor, (Math.floor(gap / n) + 1) * n);
    if (diffDays(anchor, after) < 0) next = anchor;
  } else if (rule.frequency === "weekly") {
    const days = rule.byWeekday.length ? rule.byWeekday : [weekdayOf(anchor)];
    const anchorWeek = weekStart(anchor);
    for (let i = 1; i <= 7 * n * 2 + 7; i++) {
      const candidate = addDays(after, i);
      if (!days.includes(weekdayOf(candidate))) continue;
      const weeks = diffDays(anchorWeek, weekStart(candidate)) / 7;
      if (weeks >= 0 && weeks % n === 0) {
        next = candidate;
        break;
      }
    }
  } else if (rule.frequency === "monthly") {
    const [ay, am, ad] = parts(anchor);
    const day = rule.byMonthday ?? ad;
    const [y, m] = parts(after);
    for (let i = 0; i <= 12 * n + 12; i++) {
      const idx = y * 12 + (m - 1) + i;
      const cy = Math.floor(idx / 12);
      const cm = (idx % 12) + 1;
      if (((cy * 12 + cm - 1) - (ay * 12 + am - 1)) % n !== 0) continue;
      const candidate = clampedDate(cy, cm, day);
      if (candidate > after) {
        next = candidate;
        break;
      }
    }
  } else {
    const [ay, am, ad] = parts(anchor);
    const [y] = parts(after);
    for (let i = 0; i <= n + 2; i++) {
      const cy = y + i;
      if ((cy - ay) % n !== 0) continue;
      const candidate = clampedDate(cy, am, ad);
      if (candidate > after) {
        next = candidate;
        break;
      }
    }
  }

  if (!next || (rule.endsOn && next > rule.endsOn)) return null;
  return next;
}

export function describeRecurrence(r: Recurrence): string {
  const every = (unit: string) => (r.interval === 1 ? `Every ${unit}` : `Every ${r.interval} ${unit}s`);
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let text: string;
  if (r.frequency === "daily") text = every("day");
  else if (r.frequency === "weekly") {
    const days = [...r.byWeekday].sort();
    if (days.join() === WEEKDAYS_MON_FRI.join() && r.interval === 1) text = "Every weekday";
    else text = `${every("week")}${days.length ? ` on ${days.map((d) => names[d]).join(", ")}` : ""}`;
  } else if (r.frequency === "monthly") text = `${every("month")}${r.byMonthday ? ` on day ${r.byMonthday}` : ""}`;
  else text = every("year");
  if (r.endsOn) text += `, until ${r.endsOn}`;
  if (r.maxCount) text += `, ${r.maxCount} times`;
  return text;
}
