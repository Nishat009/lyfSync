"use client";

import { localDate, localTime, type DashboardData, type TaskSummary, type UpcomingReminder } from "@lifesync/shared";
import { AlertCircle, Bell, CalendarClock, CheckCircle2, ListTodo, Plus, Sun } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, EmptyState, ErrorState, Skeleton } from "@/components/ui/card";
import { useQuery } from "@/lib/use-query";
import { formatDay, formatTime } from "@/lib/utils";
import { useTaskDialogs } from "./task-dialogs";
import { useQuickAdd } from "./quick-add";
import { useSession } from "./session";
import { TaskRow } from "./task-row";

function greeting(timezone: string) {
  const hour = Number(localTime(Date.now(), timezone).slice(0, 2));
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

function Stat({ icon: Icon, label, value, tone }: { icon: typeof Sun; label: string; value: string; tone?: string }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span className={`grid size-9 place-items-center rounded-lg ${tone ?? "bg-surface-muted text-muted"}`}>
        <Icon className="size-4" />
      </span>
      <div>
        <p className="text-xl font-semibold leading-none">{value}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </Card>
  );
}

function TaskList({
  title,
  description,
  tasks,
  empty,
  showWorkspace,
  showDate,
}: {
  title: string;
  description?: string;
  tasks: TaskSummary[];
  empty: string;
  showWorkspace: boolean;
  showDate?: boolean;
}) {
  return (
    <Card className="pb-2">
      <CardHeader title={title} description={description} />
      {tasks.length === 0 ? (
        <p className="px-5 pb-4 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} showWorkspace={showWorkspace} showDate={showDate} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function UpcomingReminders({ workspaceId }: { workspaceId?: string }) {
  const { profile } = useSession();
  const { openTask } = useTaskDialogs();
  const { data } = useQuery<UpcomingReminder[]>("/api/reminders/upcoming?limit=20");
  const list = (data ?? []).filter((r) => !workspaceId || r.workspaceId === workspaceId).slice(0, 5);
  return (
    <Card className="pb-2">
      <CardHeader title="Upcoming reminders" description="Notifications scheduled for you" />
      {list.length === 0 ? (
        <p className="px-5 pb-4 text-sm text-muted">No reminders scheduled. Add one when you create or edit a task.</p>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((r) => {
            const when = new Date(r.remindAt);
            return (
              <li key={r.id}>
                <button onClick={() => openTask(r.taskId)} className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-surface-muted">
                  <Bell className="size-4 shrink-0 text-warning" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm">{r.taskTitle}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {formatDay(localDate(when, profile.timezone))}, {formatTime(localTime(when, profile.timezone))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Balance({ data }: { data: DashboardData }) {
  const rows = [
    { label: "Open tasks", ...data.balance.open },
    { label: "Completed, last 7 days", ...data.balance.completedLast7Days },
  ];
  return (
    <Card>
      <CardHeader title="Work and personal" description="A look at where your attention is going." />
      <div className="space-y-4 px-5 pb-5">
        {rows.map((r) => {
          const total = r.work + r.personal;
          return (
            <div key={r.label}>
              <div className="mb-1.5 flex justify-between text-xs text-muted">
                <span>{r.label}</span>
                <span>
                  <span className="text-work">Work {r.work}</span> · <span className="text-personal">Personal {r.personal}</span>
                </span>
              </div>
              <div className="flex h-2 overflow-hidden rounded-full bg-surface-muted" role="img" aria-label={`${r.label}: ${r.work} work, ${r.personal} personal`}>
                {total > 0 && (
                  <>
                    <span className="bg-work" style={{ width: `${(r.work / total) * 100}%` }} />
                    <span className="bg-personal" style={{ width: `${(r.personal / total) * 100}%` }} />
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function WeeklyChart({ data }: { data: DashboardData }) {
  const points = data.weekly.map((d) => ({ ...d, day: formatDay(d.date).split(" ")[0]! }));
  const summary = points.map((p) => `${p.day}: ${p.completed} completed of ${p.due} due`).join("; ");
  return (
    <Card>
      <CardHeader title="This week" description="Tasks completed and tasks that were due, last 7 days." />
      <div className="h-56 px-3 pb-4" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 8, right: 8, left: -20, bottom: 0 }} barGap={4}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={12} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} />
            <Tooltip cursor={{ fill: "var(--surface-muted)" }} contentStyle={{ borderRadius: 8, border: "1px solid var(--border)", fontSize: 12 }} />
            <Bar dataKey="due" name="Due" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
            <Bar dataKey="completed" name="Completed" fill="var(--personal)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4" aria-busy aria-label="Loading dashboard">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[74px]" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
    </div>
  );
}

export function DashboardView({ workspaceId }: { workspaceId?: string }) {
  const { profile } = useSession();
  const openQuickAdd = useQuickAdd();
  const { data, error, loading, reload } = useQuery<DashboardData>(
    `/api/dashboard${workspaceId ? `?workspaceId=${workspaceId}` : ""}`,
  );
  const combined = !workspaceId;
  const first = profile.fullName.split(" ")[0];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {greeting(profile.timezone)}, {first}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {data ? formatDay(data.today) : " "}
            {data && data.scope.type === "workspace" && ` · ${data.scope.workspaceName}`}
            {combined && " · Personal and work together"}
          </p>
        </div>
        <Button onClick={openQuickAdd}>
          <Plus /> Add task
        </Button>
      </div>

      {loading && !data ? (
        <DashboardSkeleton />
      ) : error ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat icon={CheckCircle2} label="Completed today" value={String(data.summary.completed)} tone="bg-personal-soft text-personal" />
            <Stat icon={ListTodo} label="Pending today" value={String(data.summary.pending)} tone="bg-work-soft text-work" />
            <Stat icon={AlertCircle} label="Overdue" value={String(data.summary.overdue)} tone={data.summary.overdue ? "bg-danger-soft text-danger" : undefined} />
            <Card className="p-4">
              <div className="flex items-baseline justify-between">
                <p className="text-xl font-semibold leading-none">{data.summary.progress}%</p>
                <p className="text-xs text-muted">Today&apos;s progress</p>
              </div>
              <div
                className="mt-3 h-2 overflow-hidden rounded-full bg-surface-muted"
                role="progressbar"
                aria-valuenow={data.summary.progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Today's progress"
              >
                <div className="h-full rounded-full bg-personal transition-[width]" style={{ width: `${data.summary.progress}%` }} />
              </div>
            </Card>
          </div>

          {data.summary.total === 0 && data.overdueTasks.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Sun />}
                title="Nothing planned for today"
                description="Add a task, or enjoy the open space."
                action={
                  <Button size="sm" onClick={openQuickAdd}>
                    <Plus /> Add a task
                  </Button>
                }
              />
            </Card>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <TaskList
              title="Today's schedule"
              description="Tasks with a set time"
              tasks={data.schedule}
              empty="Nothing scheduled at a specific time."
              showWorkspace={combined}
            />
            <TaskList title="Today's tasks" description="Due today, any time" tasks={data.todayTasks} empty="No untimed tasks for today." showWorkspace={combined} />
            {data.overdueTasks.length > 0 && (
              <TaskList title="Overdue" description="Open tasks past their due date" tasks={data.overdueTasks} empty="" showWorkspace={combined} showDate />
            )}
            <UpcomingReminders workspaceId={workspaceId} />
            <TaskList
              title="Coming up"
              description="Next 7 days"
              tasks={data.upcomingTasks}
              empty="Nothing due in the next week."
              showWorkspace={combined}
              showDate
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <WeeklyChart data={data} />
            {combined ? (
              <Balance data={data} />
            ) : (
              <Card>
                <CardHeader title="Open tasks by priority" />
                <ul className="space-y-2 px-5 pb-5 text-sm">
                  {(["urgent", "high", "medium", "low"] as const).map((p) => (
                    <li key={p} className="flex items-center justify-between">
                      <span className="capitalize">{p}</span>
                      <span className="font-medium">{data.openByPriority[p]}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <CalendarClock className="size-3.5" /> Times shown in {data.timezone}.
          </p>
        </>
      ) : null}
    </div>
  );
}
