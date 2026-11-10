"use client";

import { addDays, localDate, weekdayOf, type CalendarData, type CalendarItem, type UpcomingReminder } from "@lifesync/shared";
import { AlertTriangle, Bell, CalendarDays, ChevronLeft, ChevronRight, Plus, Repeat } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, Skeleton } from "@/components/ui/card";
import { api } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/use-query";
import { cn, formatDay, formatTime } from "@/lib/utils";
import { useSession } from "./session";
import { useTaskDialogs } from "./task-dialogs";

type Mode = "day" | "week" | "month" | "agenda";
const MODES: { id: Mode; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "agenda", label: "Agenda" },
];

const HOUR_H = 56;
const SLOT_MIN = 30;
const SLOT_H = (HOUR_H * SLOT_MIN) / 60;
const MODE_KEY = "lifesync.calendar.mode";

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const isOpen = (i: CalendarItem) => i.status === "todo" || i.status === "in_progress";

/** Where a task sits on the day: a span when it has a start time that day, otherwise from its due time for its estimate. */
function blockOf(i: CalendarItem): { start: number; end: number } | null {
  if (!i.dueTime) return null;
  const due = toMin(i.dueTime);
  if (i.startTime && i.startDate === i.dueDate && toMin(i.startTime) < due) return { start: toMin(i.startTime), end: due };
  const dur = Math.min(Math.max(i.estimatedMinutes ?? 30, 15), 24 * 60 - due);
  return { start: due, end: Math.min(due + dur, 24 * 60) };
}

/** Ids of open timed tasks that overlap another open timed task on the same day. */
function findConflicts(items: CalendarItem[]): Set<string> {
  const out = new Set<string>();
  const byDay = new Map<string, { id: string; start: number; end: number }[]>();
  for (const i of items) {
    const b = isOpen(i) && i.dueDate ? blockOf(i) : null;
    if (!b || !i.dueDate) continue;
    byDay.set(i.dueDate, [...(byDay.get(i.dueDate) ?? []), { id: i.id, ...b }]);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length && list[y]!.start < list[x]!.end; y++) {
        out.add(list[x]!.id);
        out.add(list[y]!.id);
      }
    }
  }
  return out;
}

function weekStartOf(date: string, weekStartsOn: number): string {
  return addDays(date, -((weekdayOf(date) - weekStartsOn + 7) % 7));
}

function rangeFor(mode: Mode, cursor: string, weekStartsOn: number): { from: string; to: string } {
  if (mode === "day") return { from: cursor, to: cursor };
  if (mode === "week") {
    const from = weekStartOf(cursor, weekStartsOn);
    return { from, to: addDays(from, 6) };
  }
  if (mode === "month") {
    const first = `${cursor.slice(0, 8)}01`;
    const from = weekStartOf(first, weekStartsOn);
    return { from, to: addDays(from, 41) };
  }
  return { from: cursor, to: addDays(cursor, 30) };
}

function shift(mode: Mode, cursor: string, dir: 1 | -1): string {
  if (mode === "day") return addDays(cursor, dir);
  if (mode === "week") return addDays(cursor, 7 * dir);
  if (mode === "agenda") return addDays(cursor, 30 * dir);
  const [y, m] = cursor.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + dir;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}-01`;
}

function title(mode: Mode, cursor: string, from: string, to: string): string {
  const fmt = (d: string, o: Intl.DateTimeFormatOptions) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
  if (mode === "month") return fmt(cursor, { month: "long", year: "numeric" });
  if (mode === "day") return fmt(cursor, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (mode === "week") return `${fmt(from, { day: "numeric", month: "short" })} – ${fmt(to, { day: "numeric", month: "short", year: "numeric" })}`;
  return `Next 30 days from ${fmt(from, { day: "numeric", month: "short" })}`;
}

async function reschedule(item: CalendarItem, body: Record<string, unknown>, message: string) {
  try {
    await api(`/api/tasks/${item.id}`, { method: "PATCH", body });
    invalidate("/api/tasks");
    toast.success(message);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Could not reschedule");
  }
}

function chipTone(i: CalendarItem) {
  const work = i.workspaceType === "organization";
  if (i.status === "completed") return "bg-surface-muted text-muted line-through";
  return work ? "bg-work-soft text-work" : "bg-personal-soft text-personal";
}

function TaskChip({ item, conflict, onOpen, block }: { item: CalendarItem; conflict: boolean; onOpen: () => void; block?: boolean }) {
  return (
    <button
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/task-id", item.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onOpen}
      title={item.title}
      className={cn(
        "flex w-full cursor-grab gap-1 rounded px-1.5 py-0.5 text-left text-xs font-medium",
        block ? "h-full flex-wrap content-start overflow-hidden" : "items-center truncate",
        chipTone(item),
        conflict && "ring-1 ring-warning",
      )}
    >
      {conflict && <AlertTriangle className="size-3 shrink-0 text-warning" aria-label="Scheduling conflict" />}
      {item.dueTime && <span className="shrink-0 opacity-70">{formatTime(item.dueTime)}</span>}
      <span className="truncate">{item.title}</span>
      {item.recurring && <Repeat className="size-3 shrink-0 opacity-60" aria-label="Repeats" />}
    </button>
  );
}

export function CalendarView({ workspaceId }: { workspaceId?: string }) {
  const { profile, workspaces } = useSession();
  const { openTask, openCreate } = useTaskDialogs();
  const [today] = useState(() => localDate(Date.now(), profile.timezone));
  const [mode, setMode] = useState<Mode>(() => {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      return saved === "day" || saved === "week" || saved === "month" || saved === "agenda" ? saved : "week";
    } catch {
      return "week";
    }
  });
  const [cursor, setCursor] = useState(today);
  const range = rangeFor(mode, cursor, profile.weekStartsOn);
  const { data, error, loading, reload } = useQuery<CalendarData>(
    `/api/calendar?from=${range.from}&to=${range.to}${workspaceId ? `&workspaceId=${workspaceId}` : ""}`,
  );
  const items = useMemo(() => data?.items ?? [], [data]);
  const conflicts = useMemo(() => findConflicts(items), [items]);
  const createIn = workspaceId ?? workspaces.find((w) => w.type === "personal")?.id;
  const byId = (id: string) => items.find((i) => i.id === id);

  const changeMode = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {}
  };

  const days = useMemo(() => {
    const n = mode === "day" ? 1 : mode === "week" ? 7 : mode === "month" ? 42 : 0;
    return Array.from({ length: n }, (_, i) => addDays(range.from, i));
  }, [mode, range.from]);

  const dropOnDay = (day: string, e: React.DragEvent, time?: string) => {
    e.preventDefault();
    const item = byId(e.dataTransfer.getData("text/task-id"));
    if (!item) return;
    if (time === undefined) {
      // dropped on a whole day (month cell or all-day strip): keep the time, change the date
      if (item.dueDate === day) return;
      const body: Record<string, unknown> = { dueDate: day };
      if (item.startDate && item.startDate !== day) body.startDate = null;
      void reschedule(item, body, `Moved to ${formatDay(day)}`);
      return;
    }
    const block = blockOf(item);
    const span = block ? block.end - block.start : 0;
    const spansWithStart = !!(item.startTime && item.startDate === item.dueDate && block);
    const body: Record<string, unknown> = { dueDate: day, dueTime: spansWithStart ? toTime(toMin(time) + span) : time };
    if (spansWithStart) Object.assign(body, { startDate: day, startTime: time });
    void reschedule(item, body, `Moved to ${formatDay(day)}, ${formatTime(time)}`);
  };

  const conflictDays = new Set(items.filter((i) => conflicts.has(i.id)).map((i) => i.dueDate));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Calendar</h1>
        </div>
        <Button onClick={() => createIn && openCreate(createIn, { dueDate: mode === "month" || mode === "agenda" ? today : cursor })}>
          <Plus /> New task
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="icon" aria-label="Previous" onClick={() => setCursor(shift(mode, cursor, -1))}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon" aria-label="Next" onClick={() => setCursor(shift(mode, cursor, 1))}>
            <ChevronRight />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCursor(today)}>
            Today
          </Button>
          <h2 className="ml-2 text-base font-semibold" aria-live="polite">
            {title(mode, cursor, range.from, range.to)}
          </h2>
        </div>
        <div role="group" aria-label="Calendar view" className="flex rounded-lg border border-border bg-surface p-0.5">
          {MODES.map((m) => (
            <button
              key={m.id}
              aria-pressed={mode === m.id}
              onClick={() => changeMode(m.id)}
              className={cn("rounded-md px-3 py-1.5 text-sm", mode === m.id ? "bg-surface-muted font-medium" : "text-muted")}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {conflicts.size > 0 && (
        <p role="status" className="flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
          <AlertTriangle className="size-4" aria-hidden />
          {conflicts.size} tasks overlap in time on {conflictDays.size} {conflictDays.size === 1 ? "day" : "days"}. They are outlined below.
        </p>
      )}

      {loading && !data ? (
        <Skeleton className="h-96" />
      ) : error ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : data ? (
        mode === "month" ? (
          <MonthGrid days={days} cursor={cursor} today={today} weekStartsOn={profile.weekStartsOn} items={items} conflicts={conflicts} onOpen={openTask} onDrop={dropOnDay}
            onCreate={(d) => createIn && openCreate(createIn, { dueDate: d })} onDay={(d) => { setCursor(d); changeMode("day"); }} />
        ) : mode === "agenda" ? (
          <Agenda items={items} reminders={data.reminders} conflicts={conflicts} from={range.from} to={range.to} onOpen={openTask} timezone={profile.timezone} />
        ) : (
          <TimeGrid days={days} today={today} items={items} reminders={data.reminders} conflicts={conflicts} timezone={profile.timezone} onOpen={openTask}
            onDrop={dropOnDay} onCreate={(d, t) => createIn && openCreate(createIn, { dueDate: d, dueTime: t })} />
        )
      ) : null}
    </div>
  );
}

function MonthGrid({
  days, cursor, today, weekStartsOn, items, conflicts, onOpen, onDrop, onCreate, onDay,
}: {
  days: string[]; cursor: string; today: string; weekStartsOn: number; items: CalendarItem[]; conflicts: Set<string>;
  onOpen: (id: string) => void; onDrop: (day: string, e: React.DragEvent) => void; onCreate: (day: string) => void; onDay: (day: string) => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const header = Array.from({ length: 7 }, (_, i) => names[(weekStartsOn + i) % 7]!);
  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-7 border-b border-border bg-surface-muted text-center text-xs font-medium text-muted">
        {header.map((h) => (
          <div key={h} className="py-2">
            {h}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const dayItems = items.filter((i) => i.dueDate === d);
          const inMonth = d.slice(0, 7) === cursor.slice(0, 7);
          return (
            <div
              key={d}
              data-date={d}
              onDragOver={(e) => { e.preventDefault(); setOver(d); }}
              onDragLeave={() => setOver((o) => (o === d ? null : o))}
              onDrop={(e) => { setOver(null); onDrop(d, e); }}
              className={cn("group min-h-28 border-b border-r border-border p-1.5", !inMonth && "bg-surface-muted/50", over === d && "bg-work-soft")}
            >
              <div className="mb-1 flex items-center justify-between">
                <button
                  onClick={() => onDay(d)}
                  aria-label={`Open ${formatDay(d)}`}
                  className={cn("grid size-6 place-items-center rounded-full text-xs", d === today ? "bg-foreground font-semibold text-white" : inMonth ? "hover:bg-surface-muted" : "text-muted hover:bg-surface-muted")}
                >
                  {Number(d.slice(8))}
                </button>
                <button onClick={() => onCreate(d)} aria-label={`Add task on ${formatDay(d)}`} className="rounded p-0.5 text-muted opacity-0 hover:bg-surface-muted focus:opacity-100 group-hover:opacity-100">
                  <Plus className="size-3.5" />
                </button>
              </div>
              <div className="space-y-0.5">
                {dayItems.slice(0, 3).map((i) => (
                  <TaskChip key={i.id} item={i} conflict={conflicts.has(i.id)} onOpen={() => onOpen(i.id)} />
                ))}
                {dayItems.length > 3 && (
                  <button onClick={() => onDay(d)} className="px-1.5 text-xs text-muted hover:underline">
                    +{dayItems.length - 3} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function TimeGrid({
  days, today, items, reminders, conflicts, timezone, onOpen, onDrop, onCreate,
}: {
  days: string[]; today: string; items: CalendarItem[]; reminders: UpcomingReminder[]; conflicts: Set<string>; timezone: string;
  onOpen: (id: string) => void; onDrop: (day: string, e: React.DragEvent, time?: string) => void; onCreate: (day: string, time: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_H - 8;
  }, []);
  const slots = Array.from({ length: (24 * 60) / SLOT_MIN }, (_, i) => i * SLOT_MIN);
  const remindersFor = (day: string) =>
    reminders.filter((r) => {
      const d = new Date(r.remindAt);
      return localDate(d, timezone) === day;
    });
  const minuteOf = (iso: string) => {
    const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone }).format(new Date(iso)).split(":");
    return Number(parts[0]) * 60 + Number(parts[1]);
  };
  const cols = `3.5rem repeat(${days.length}, minmax(${days.length === 1 ? "0" : "7rem"}, 1fr))`;

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <div style={{ gridTemplateColumns: cols }} className="grid min-w-fit border-b border-border bg-surface-muted/60">
          <div />
          {days.map((d) => {
            const allDay = items.filter((i) => i.dueDate === d && !i.dueTime);
            return (
              <div
                key={d}
                onDragOver={(e) => { e.preventDefault(); setOver(`all-${d}`); }}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => { setOver(null); onDrop(d, e); }}
                className={cn("border-l border-border p-1.5", over === `all-${d}` && "bg-work-soft")}
              >
                <p className={cn("mb-1 text-center text-xs font-medium", d === today ? "text-work" : "text-muted")}>{formatDay(d)}</p>
                <div className="min-h-6 space-y-0.5" aria-label={`All-day tasks ${formatDay(d)}`}>
                  {allDay.map((i) => (
                    <TaskChip key={i.id} item={i} conflict={false} onOpen={() => onOpen(i.id)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div ref={scroller} className="max-h-[34rem] overflow-y-auto">
          <div style={{ gridTemplateColumns: cols }} className="relative grid min-w-fit">
            <div className="relative" style={{ height: 24 * HOUR_H }}>
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h} style={{ top: h * HOUR_H - 7 }} className="absolute right-2 text-[10px] text-muted">
                  {h === 0 ? "" : formatTime(`${String(h).padStart(2, "0")}:00`)}
                </span>
              ))}
            </div>
            {days.map((d) => {
              const timed = items
                .filter((i) => i.dueDate === d && i.dueTime)
                .map((i) => ({ i, b: blockOf(i)! }))
                .sort((a, b) => a.b.start - b.b.start);
              // side-by-side lanes for overlapping tasks
              const laneEnds: number[] = [];
              const placed = timed.map(({ i, b }) => {
                let lane = laneEnds.findIndex((end) => end <= b.start);
                if (lane === -1) lane = laneEnds.length;
                laneEnds[lane] = b.end;
                return { i, b, lane };
              });
              const lanes = Math.max(1, laneEnds.length);
              return (
                <div key={d} data-day={d} className="relative border-l border-border" style={{ height: 24 * HOUR_H }}>
                  {slots.map((s) => (
                    <div
                      key={s}
                      data-slot={`${d} ${toTime(s)}`}
                      role="button"
                      tabIndex={-1}
                      aria-label={`Add task ${formatDay(d)} ${formatTime(toTime(s))}`}
                      onClick={() => onCreate(d, toTime(s))}
                      onDragOver={(e) => { e.preventDefault(); setOver(`${d} ${s}`); }}
                      onDragLeave={() => setOver((o) => (o === `${d} ${s}` ? null : o))}
                      onDrop={(e) => { setOver(null); onDrop(d, e, toTime(s)); }}
                      style={{ height: SLOT_H }}
                      className={cn("cursor-cell", s % 60 === 0 ? "border-t border-border" : "border-t border-dashed border-border/60", over === `${d} ${s}` && "bg-work-soft")}
                    />
                  ))}
                  {placed.map(({ i, b, lane }) => (
                    <div
                      key={i.id}
                      style={{ top: (b.start / 60) * HOUR_H, height: Math.max(((b.end - b.start) / 60) * HOUR_H, 44), left: `${(lane / lanes) * 100}%`, width: `${100 / lanes}%` }}
                      className="absolute z-10 p-0.5"
                    >
                      <div className="h-full overflow-hidden">
                        <TaskChip item={i} conflict={conflicts.has(i.id)} onOpen={() => onOpen(i.id)} block />
                      </div>
                    </div>
                  ))}
                  {remindersFor(d).map((r) => (
                    <button
                      key={r.id}
                      onClick={() => onOpen(r.taskId)}
                      title={`Reminder: ${r.taskTitle}`}
                      aria-label={`Reminder for ${r.taskTitle}`}
                      style={{ top: (minuteOf(r.remindAt) / 60) * HOUR_H - 7 }}
                      className="absolute right-0.5 z-20 rounded-full bg-surface p-0.5 text-warning shadow-card"
                    >
                      <Bell className="size-3" />
                    </button>
                  ))}
                  {d === today && (
                    <div className="pointer-events-none absolute inset-x-0 z-20 h-px bg-danger" style={{ top: (minuteOf(new Date().toISOString()) / 60) * HOUR_H }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Card>
  );
}

function Agenda({
  items, reminders, conflicts, from, to, onOpen, timezone,
}: {
  items: CalendarItem[]; reminders: UpcomingReminder[]; conflicts: Set<string>; from: string; to: string; onOpen: (id: string) => void; timezone: string;
}) {
  const dayList = Array.from({ length: 31 }, (_, i) => addDays(from, i)).filter((d) => d <= to);
  const rows = dayList
    .map((d) => ({
      day: d,
      tasks: items.filter((i) => i.dueDate === d),
      rem: reminders.filter((r) => localDate(new Date(r.remindAt), timezone) === d),
    }))
    .filter((r) => r.tasks.length || r.rem.length);
  if (!rows.length) {
    return (
      <Card>
        <EmptyState icon={<CalendarDays />} title="Nothing scheduled" description="No tasks or reminders in the next 30 days." />
      </Card>
    );
  }
  return (
    <Card className="divide-y divide-border">
      {rows.map(({ day, tasks, rem }) => (
        <section key={day} aria-label={formatDay(day)} className="grid gap-2 p-4 sm:grid-cols-[9rem_1fr]">
          <h3 className="text-sm font-semibold">{formatDay(day)}</h3>
          <ul className="space-y-1.5">
            {tasks.map((i) => (
              <li key={i.id}>
                <button onClick={() => onOpen(i.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-muted">
                  <span className="w-16 shrink-0 text-xs text-muted">{i.dueTime ? formatTime(i.dueTime) : "All day"}</span>
                  <span className={cn("size-2 shrink-0 rounded-full", i.workspaceType === "organization" ? "bg-work" : "bg-personal")} aria-hidden />
                  <span className={cn("truncate", i.status === "completed" && "text-muted line-through")}>{i.title}</span>
                  {i.recurring && <Repeat className="size-3 text-muted" aria-label="Repeats" />}
                  {conflicts.has(i.id) && (
                    <span className="ml-auto flex items-center gap-1 text-xs text-warning">
                      <AlertTriangle className="size-3" /> Overlaps
                    </span>
                  )}
                </button>
              </li>
            ))}
            {rem.map((r) => (
              <li key={r.id}>
                <button onClick={() => onOpen(r.taskId)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs text-muted hover:bg-surface-muted">
                  <Bell className="size-3 text-warning" aria-hidden />
                  <span className="w-16 shrink-0">
                    {new Date(r.remindAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone })}
                  </span>
                  Reminder: {r.taskTitle}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Card>
  );
}
