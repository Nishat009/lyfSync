/** Time-zone helpers built on Intl, so no date library is needed on the server. */

function partsIn(ts: number, timeZone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ts))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset of `timeZone` from UTC at instant `ts`, in milliseconds (positive east of UTC). */
export function tzOffsetMs(ts: number, timeZone: string): number {
  const p = partsIn(ts, timeZone);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Local calendar date ("YYYY-MM-DD") of an instant in a time zone. */
export function localDate(ts: number | Date, timeZone: string): string {
  const t = typeof ts === "number" ? ts : ts.getTime();
  const p = partsIn(t, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Local wall-clock time ("HH:MM") of an instant in a time zone. */
export function localTime(ts: number | Date, timeZone: string): string {
  const t = typeof ts === "number" ? ts : ts.getTime();
  const p = partsIn(t, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** Converts a local date + time in `timeZone` to the UTC instant. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let ts = naive - tzOffsetMs(naive, timeZone);
  // Across a DST change the first guess can be an hour off; settle on the offset at the result.
  const second = naive - tzOffsetMs(ts, timeZone);
  if (second !== ts) ts = second;
  return new Date(ts);
}

/** Adds whole days to a "YYYY-MM-DD" date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Day of week (0 = Sunday) of a "YYYY-MM-DD" date. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Combines a local date and time into the UTC instant used for sorting and reminders. */
export function toInstant(date: string, time: string, timeZone: string): string {
  return zonedToUtc(date, time, timeZone).toISOString();
}
