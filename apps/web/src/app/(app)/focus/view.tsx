"use client";

import type { FocusKind, FocusSession, FocusSummary, TaskListItem } from "@lifesync/shared";
import { Coffee, Play, Settings2, Square, Target } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, EmptyState, ErrorState, Skeleton } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { api, ApiError } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/use-query";
import { cn, timeAgo } from "@/lib/utils";

interface Settings {
  focus: number;
  shortBreak: number;
  longBreak: number;
  longEvery: number;
}
const DEFAULTS: Settings = { focus: 25, shortBreak: 5, longBreak: 15, longEvery: 4 };
const STORAGE_KEY = "lifesync.focus.settings";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // Storage can be blocked; the defaults are fine.
  }
  return DEFAULTS;
}

const KIND_LABEL: Record<FocusKind, string> = { focus: "Focus", short_break: "Short break", long_break: "Long break" };
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n) || min));

function mmss(totalSeconds: number) {
  const s = Math.max(0, totalSeconds);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function NumField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <Field label={label}>
      {(p) => <Input {...p} type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(e) => onChange(clamp(Number(e.target.value), min, max))} />}
    </Field>
  );
}

function SettingsForm({ value, onChange }: { value: Settings; onChange: (s: Settings) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <NumField label="Focus (min)" value={value.focus} min={1} max={120} onChange={(n) => onChange({ ...value, focus: n })} />
      <NumField label="Short break" value={value.shortBreak} min={1} max={60} onChange={(n) => onChange({ ...value, shortBreak: n })} />
      <NumField label="Long break" value={value.longBreak} min={1} max={120} onChange={(n) => onChange({ ...value, longBreak: n })} />
      <NumField label="Long break every" value={value.longEvery} min={2} max={12} onChange={(n) => onChange({ ...value, longEvery: n })} />
    </div>
  );
}

export default function View() {
  const summary = useQuery<FocusSummary>("/api/focus");
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [showSettings, setShowSettings] = useState(false);
  const [kind, setKind] = useState<FocusKind>("focus");
  const [taskId, setTaskId] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [cycle, setCycle] = useState(0); // focus sessions finished in a row, for the long-break rhythm
  const finishing = useRef(false);

  const tasks = useQuery<TaskListItem[]>("/api/tasks?status=open&assignee=me&limit=100");

  useEffect(() => setSettings(loadSettings()), []);
  const updateSettings = (s: Settings) => {
    setSettings(s);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      // ignore
    }
  };

  const active = summary.data?.active ?? null;
  const plannedSeconds = (active?.plannedMinutes ?? 0) * 60;
  const elapsed = active ? Math.floor((now - new Date(active.startedAt).getTime()) / 1000) : 0;
  const remaining = active ? plannedSeconds - elapsed : 0;

  // The server owns the start time, so a refresh or a second tab shows the same countdown.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  const finish = useCallback(
    async (session: FocusSession, completed: boolean, seconds: number) => {
      if (finishing.current) return;
      finishing.current = true;
      try {
        await api(`/api/focus/${session.id}/finish`, { body: { actualSeconds: Math.min(seconds, session.plannedMinutes * 60), completed } });
        invalidate("/api/focus");
        invalidate("/api/tasks");
        invalidate("/api/analytics");
        if (session.kind === "focus" && completed) {
          setCycle((c) => c + 1);
          toast.success("Focus session complete. Time for a break.");
          setKind((cycle + 1) % settings.longEvery === 0 ? "long_break" : "short_break");
        } else if (session.kind !== "focus" && completed) {
          toast.success("Break over. Ready when you are.");
          setKind("focus");
        }
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Could not save the session");
      } finally {
        finishing.current = false;
      }
    },
    [cycle, settings.longEvery],
  );

  // Auto-finish when the countdown hits zero.
  useEffect(() => {
    if (active && remaining <= 0) void finish(active, true, plannedSeconds);
  }, [active, remaining, plannedSeconds, finish]);

  const minutesFor = (k: FocusKind) => (k === "focus" ? settings.focus : k === "short_break" ? settings.shortBreak : settings.longBreak);

  async function start() {
    setBusy(true);
    try {
      await api("/api/focus", { body: { kind, plannedMinutes: minutesFor(kind), taskId: kind === "focus" && taskId ? taskId : null } });
      setNow(Date.now());
      invalidate("/api/focus");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not start the timer");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!active) return;
    setBusy(true);
    await finish(active, false, Math.max(0, elapsed));
    setBusy(false);
  }

  const display = active ? remaining : minutesFor(kind) * 60;
  const progress = active ? Math.min(100, Math.max(0, (elapsed / plannedSeconds) * 100)) : 0;
  const taskTitle = active?.taskTitle;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Focus</h1>
        <p className="text-sm text-muted">One thing at a time. Time spent is added to the task you pick.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card className="p-6">
          <div role="tablist" aria-label="Session type" className="mb-6 flex justify-center gap-1 rounded-lg bg-surface-muted p-1">
            {(Object.keys(KIND_LABEL) as FocusKind[]).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={(active?.kind ?? kind) === k}
                disabled={!!active}
                onClick={() => setKind(k)}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-default",
                  (active?.kind ?? kind) === k ? "bg-surface shadow-card" : "text-muted hover:text-foreground",
                )}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>

          <div className="flex flex-col items-center gap-2">
            <div
              role="timer"
              aria-live="off"
              aria-label={`${KIND_LABEL[active?.kind ?? kind]} timer`}
              className={cn("text-7xl font-semibold tabular-nums tracking-tight", (active?.kind ?? kind) === "focus" ? "text-work" : "text-personal")}
            >
              {mmss(display)}
            </div>
            <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-surface-muted" aria-hidden>
              <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-1000 ease-linear" style={{ width: `${progress}%` }} />
            </div>
            <p className="min-h-5 text-sm text-muted">
              {active ? (taskTitle ? `Working on: ${taskTitle}` : active.kind === "focus" ? "Free focus" : "Step away from the screen") : "Ready"}
            </p>
          </div>

          {!active && kind === "focus" && (
            <div className="mx-auto mt-5 max-w-sm">
              <Field label="Task (optional)">
                {(p) => (
                  <Select {...p} value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                    <option value="">No task</option>
                    {(tasks.data ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title} · {t.workspaceName}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          )}

          <div className="mt-6 flex justify-center gap-2">
            {!active ? (
              <Button size="md" variant={kind === "focus" ? "work" : "personal"} onClick={start} loading={busy} disabled={summary.loading}>
                {kind === "focus" ? <Play /> : <Coffee />} Start {KIND_LABEL[kind].toLowerCase()}
              </Button>
            ) : (
              <>
                <Button variant="danger" onClick={stop} loading={busy}>
                  <Square /> Stop and save
                </Button>
              </>
            )}
          </div>
          <div className="mt-6 border-t border-border pt-3">
            <button
              type="button"
              className="mx-auto flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground"
              aria-expanded={showSettings}
              onClick={() => setShowSettings((s) => !s)}
            >
              <Settings2 className="size-3.5" /> Timer settings
            </button>
            {showSettings && <div className="mt-3"><SettingsForm value={settings} onChange={updateSettings} /></div>}
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Today" description="Focus time only, breaks are not counted." />
            {summary.error ? (
              <ErrorState message={summary.error.message} onRetry={summary.reload} />
            ) : !summary.data ? (
              <Skeleton className="m-5 h-16" />
            ) : (
              <div className="grid grid-cols-3 gap-3 px-5 pb-5 text-center">
                <div>
                  <p className="text-xl font-semibold">{summary.data.todayFocusMinutes}</p>
                  <p className="text-xs text-muted">minutes</p>
                </div>
                <div>
                  <p className="text-xl font-semibold">{summary.data.todaySessions}</p>
                  <p className="text-xs text-muted">sessions</p>
                </div>
                <div>
                  <p className="text-xl font-semibold">{(summary.data.weekFocusMinutes / 60).toFixed(1)}</p>
                  <p className="text-xs text-muted">hours, 7 days</p>
                </div>
              </div>
            )}
          </Card>
          <Card>
            <CardHeader title="Recent sessions" />
            {!summary.data ? (
              <Skeleton className="m-5 h-20" />
            ) : summary.data.recent.length === 0 ? (
              <EmptyState icon={<Target />} title="No sessions yet" description="Start a timer and your focus history shows up here." />
            ) : (
              <ul className="divide-y divide-border">
                {summary.data.recent.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                    <span className="min-w-0 truncate">{s.taskTitle ?? "Free focus"}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {Math.round(s.actualSeconds / 60)} min{s.completed ? "" : " (stopped)"} · {timeAgo(s.startedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
