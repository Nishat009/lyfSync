"use client";

import type { Analytics } from "@lifesync/shared";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useSession } from "@/components/app/session";
import { Card, CardHeader, EmptyState, ErrorState, Skeleton } from "@/components/ui/card";
import { Select } from "@/components/ui/form";
import { useQuery } from "@/lib/use-query";
import { cn } from "@/lib/utils";

const RANGES = [7, 30, 90] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WORK = "var(--work)";
const PERSONAL = "var(--personal)";

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted">{label}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

const tick = { fontSize: 11, fill: "var(--muted)" };
const tooltipStyle = { borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", fontSize: 12 };

function Split({ title, work, personal, unit }: { title: string; work: number; personal: number; unit: string }) {
  const total = work + personal;
  const w = total ? Math.round((work / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-sm">
        <span className="font-medium">{title}</span>
        <span className="text-muted tabular-nums">
          Work {work} {unit} · Personal {personal} {unit}
        </span>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-muted" role="img" aria-label={`${title}: ${w}% work, ${total ? 100 - w : 0}% personal`}>
        {total > 0 && (
          <>
            <div style={{ width: `${w}%`, background: WORK }} />
            <div style={{ width: `${100 - w}%`, background: PERSONAL }} />
          </>
        )}
      </div>
    </div>
  );
}

export default function View() {
  const { workspaces } = useSession();
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const [workspaceId, setWorkspaceId] = useState("");
  const { data, error, reload } = useQuery<Analytics>(`/api/analytics?days=${days}${workspaceId ? `&workspaceId=${workspaceId}` : ""}`);

  const best = data ? [...data.weekdays].sort((a, b) => b.completed - a.completed)[0] : undefined;
  const labelFor = (date: string) => {
    const [, m, d] = date.split("-");
    return `${Number(d)}/${Number(m)}`;
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Balance</h1>
          <p className="text-sm text-muted">A look at how your time and effort are spread. There is no score to beat.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select aria-label="Workspace" className="w-44" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            <option value="">All workspaces</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </Select>
          <div role="group" aria-label="Time range" className="flex rounded-lg border border-border bg-surface p-0.5">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={days === r}
                onClick={() => setDays(r)}
                className={cn("rounded-md px-3 py-1.5 text-sm font-medium", days === r ? "bg-surface-muted" : "text-muted hover:text-foreground")}
              >
                {r} days
              </button>
            ))}
          </div>
        </div>
      </div>

      {error ? (
        <Card><ErrorState message={error.message} onRetry={reload} /></Card>
      ) : !data ? (
        <div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Tasks completed" value={data.totals.completed} />
            <Stat label="Still open" value={data.totals.pending} hint={data.totals.pending ? `${data.totals.overduePercent}% overdue (${data.totals.overdue})` : undefined} />
            <Stat label="Focus time" value={`${(data.totals.focusMinutes / 60).toFixed(1)} h`} hint={`${data.totals.focusSessions} sessions`} />
            <Stat
              label="Habit days kept"
              value={data.habits.scheduledDays ? `${Math.round((data.habits.doneDays / data.habits.scheduledDays) * 100)}%` : "–"}
              hint={data.habits.scheduledDays ? `${data.habits.doneDays} of ${data.habits.scheduledDays}` : "No habits yet"}
            />
          </div>

          {data.totals.completed + data.totals.focusMinutes + data.totals.pending === 0 ? (
            <Card><EmptyState title="Nothing to show yet" description="Complete a task or run a focus session and your trends will appear here." /></Card>
          ) : (
            <>
              <Card>
                <CardHeader title="Completed tasks" description="Tasks you finished each day." />
                <div className="h-64 px-3 pb-4" role="img" aria-label={`Bar chart of tasks completed per day over ${days} days`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.daily.map((d) => ({ ...d, label: labelFor(d.date) }))} margin={{ left: -20, right: 8 }}>
                      <CartesianGrid vertical={false} stroke="var(--border)" />
                      <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={false} interval={days === 7 ? 0 : "preserveStartEnd"} />
                      <YAxis allowDecimals={false} tick={tick} tickLine={false} axisLine={false} />
                      <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--surface-muted)" }} />
                      <Bar dataKey="completed" name="Completed" fill={WORK} radius={[4, 4, 0, 0]} />
                      <Bar dataKey="created" name="Added" fill="var(--border)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                  <CardHeader title="Focus minutes" description="Time in focus sessions per day." />
                  <div className="h-56 px-3 pb-4" role="img" aria-label={`Bar chart of focus minutes per day over ${days} days`}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.daily.map((d) => ({ ...d, label: labelFor(d.date) }))} margin={{ left: -20, right: 8 }}>
                        <CartesianGrid vertical={false} stroke="var(--border)" />
                        <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={false} interval={days === 7 ? 0 : "preserveStartEnd"} />
                        <YAxis allowDecimals={false} tick={tick} tickLine={false} axisLine={false} />
                        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--surface-muted)" }} />
                        <Bar dataKey="focusMinutes" name="Minutes" fill={PERSONAL} radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
                <Card>
                  <CardHeader title="Work and personal" description="How your finished tasks and focus time divide." />
                  <div className="space-y-5 px-5 pb-5">
                    <Split title="Tasks completed" work={data.distribution.work.completed} personal={data.distribution.personal.completed} unit="" />
                    <Split title="Focus minutes" work={data.distribution.work.focusMinutes} personal={data.distribution.personal.focusMinutes} unit="min" />
                    <p className="flex gap-4 text-xs text-muted">
                      <span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-full" style={{ background: WORK }} /> Work</span>
                      <span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-full" style={{ background: PERSONAL }} /> Personal</span>
                    </p>
                  </div>
                </Card>
              </div>

              <Card>
                <CardHeader
                  title="Which days you finish things"
                  description={best && best.completed > 0 ? `Most tasks were completed on ${WEEKDAYS[best.weekday]}days.` : "Complete a few tasks to see a pattern."}
                />
                <div className="h-48 px-3 pb-4" role="img" aria-label="Bar chart of tasks completed by weekday">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.weekdays.map((w) => ({ day: WEEKDAYS[w.weekday], completed: w.completed }))} margin={{ left: -20, right: 8 }}>
                      <CartesianGrid vertical={false} stroke="var(--border)" />
                      <XAxis dataKey="day" tick={tick} tickLine={false} axisLine={false} />
                      <YAxis allowDecimals={false} tick={tick} tickLine={false} axisLine={false} />
                      <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--surface-muted)" }} />
                      <Bar dataKey="completed" name="Completed" fill={WORK} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
