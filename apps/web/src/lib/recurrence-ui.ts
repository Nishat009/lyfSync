import { WEEKDAYS_MON_FRI, type Recurrence, type RecurrenceFrequency } from "@lifesync/shared";

export type Preset = "none" | "daily" | "weekday" | "weekly" | "monthly" | "yearly" | "custom";

export const PRESET_LABELS: Record<Preset, string> = {
  none: "Does not repeat",
  daily: "Every day",
  weekday: "Every weekday (Mon–Fri)",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year",
  custom: "Custom…",
};

/** Form-friendly (all strings) view of a recurrence. */
export interface RecurrenceFields {
  preset: Preset;
  interval: string;
  unit: RecurrenceFrequency;
  weekdays: string[];
  endMode: "never" | "on" | "count";
  endsOn: string;
  maxCount: string;
}

export const EMPTY_RECURRENCE: RecurrenceFields = {
  preset: "none",
  interval: "1",
  unit: "weekly",
  weekdays: [],
  endMode: "never",
  endsOn: "",
  maxCount: "",
};

export function presetOf(r: Recurrence): Preset {
  const days = [...r.byWeekday].sort().join();
  if (r.interval === 1 && !r.byMonthday) {
    if (r.frequency === "daily") return "daily";
    if (r.frequency === "weekly" && days === WEEKDAYS_MON_FRI.join()) return "weekday";
    if (r.frequency === "weekly" && r.byWeekday.length === 0) return "weekly";
    if (r.frequency === "monthly") return "monthly";
    if (r.frequency === "yearly") return "yearly";
  }
  return "custom";
}

export function fieldsOf(r: Recurrence | null): RecurrenceFields {
  if (!r) return EMPTY_RECURRENCE;
  return {
    preset: presetOf(r),
    interval: String(r.interval),
    unit: r.frequency,
    weekdays: r.byWeekday.map(String),
    endMode: r.endsOn ? "on" : r.maxCount ? "count" : "never",
    endsOn: r.endsOn ?? "",
    maxCount: r.maxCount ? String(r.maxCount) : "",
  };
}

export function buildRecurrence(f: RecurrenceFields): Recurrence | null {
  if (f.preset === "none") return null;
  const base = { byWeekday: [] as number[], byMonthday: null, interval: 1 };
  let r: Pick<Recurrence, "frequency" | "interval" | "byWeekday" | "byMonthday">;
  switch (f.preset) {
    case "daily":
      r = { ...base, frequency: "daily" };
      break;
    case "weekday":
      r = { ...base, frequency: "weekly", byWeekday: [...WEEKDAYS_MON_FRI] };
      break;
    case "weekly":
      r = { ...base, frequency: "weekly" };
      break;
    case "monthly":
      r = { ...base, frequency: "monthly" };
      break;
    case "yearly":
      r = { ...base, frequency: "yearly" };
      break;
    default:
      r = {
        frequency: f.unit,
        interval: Math.min(365, Math.max(1, Number(f.interval) || 1)),
        byWeekday: f.unit === "weekly" ? f.weekdays.map(Number) : [],
        byMonthday: null,
      };
  }
  return {
    ...r,
    endsOn: f.endMode === "on" && f.endsOn ? f.endsOn : null,
    maxCount: f.endMode === "count" && f.maxCount ? Math.max(1, Number(f.maxCount)) : null,
  };
}
