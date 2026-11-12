import { addDays, weekdayOf } from "@lifesync/shared";

export interface HabitShape {
  byWeekday: number[];
  targetPerDay: number;
  /** First day the habit can be judged: the earlier of its creation day and its first log. */
  startDate: string;
}

export const dueOn = (h: HabitShape, date: string) => date >= h.startDate && h.byWeekday.includes(weekdayOf(date));
export const isDone = (h: HabitShape, count: number) => count >= h.targetPerDay;

/**
 * Streaks count consecutive scheduled days that were completed. Days the habit does not apply to are
 * skipped rather than breaking the streak, and today is never held against you until it has passed.
 */
export function computeStreaks(h: HabitShape, logs: Map<string, number>, today: string) {
  let current = 0;
  for (let d = today, i = 0; d >= h.startDate && i < 800; d = addDays(d, -1), i++) {
    if (!dueOn(h, d)) continue;
    if (isDone(h, logs.get(d) ?? 0)) current++;
    else if (d !== today) break;
  }
  let longest = 0;
  let run = 0;
  for (let d = h.startDate, i = 0; d <= today && i < 800; d = addDays(d, 1), i++) {
    if (!dueOn(h, d)) continue;
    if (isDone(h, logs.get(d) ?? 0)) {
      run++;
      longest = Math.max(longest, run);
    } else if (d !== today) {
      run = 0;
    }
  }
  return { current, longest: Math.max(longest, current) };
}
