"use client";

import { ROLE_LABELS, type ActivityEntry, type Project, type TeamOverview } from "@lifesync/shared";
import { AlertCircle, CheckCircle2, ListTodo, UserX } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { canManage, useSession, useWorkspace } from "@/components/app/session";
import { when } from "@/components/app/task-collab";
import { useTaskDialogs } from "@/components/app/task-dialogs";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, EmptyState, ErrorState, Skeleton } from "@/components/ui/card";
import { describeFeedLine } from "@/lib/activity";
import { useQuery } from "@/lib/use-query";
import { cn } from "@/lib/utils";

function Stat({ icon: Icon, label, value, tone }: { icon: typeof ListTodo; label: string; value: number; tone?: string }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span className={cn("grid size-9 place-items-center rounded-lg", tone ?? "bg-surface-muted text-muted")}>
        <Icon className="size-4" />
      </span>
      <div>
        <p className="text-xl font-semibold leading-none">{value}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </Card>
  );
}

function Num({ value, danger }: { value: number; danger?: boolean }) {
  return <span className={cn("tabular-nums", value === 0 && "text-muted", danger && value > 0 && "font-semibold text-danger")}>{value}</span>;
}

function Workload({ data, workspaceId }: { data: TeamOverview; workspaceId: string }) {
  const max = Math.max(1, ...data.members.map((m) => m.open));
  return (
    <Card>
      <CardHeader title="Workload" description="Open tasks by person. A task shared by two people counts for both." />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-y border-border text-left text-xs text-muted">
              <th scope="col" className="px-5 py-2 font-medium">Person</th>
              <th scope="col" className="px-2 py-2 font-medium">Open</th>
              <th scope="col" className="px-2 py-2 font-medium">In progress</th>
              <th scope="col" className="px-2 py-2 font-medium">Due today</th>
              <th scope="col" className="px-2 py-2 font-medium">Overdue</th>
              <th scope="col" className="px-5 py-2 font-medium">Done, 7 days</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.members.map((m) => (
              <tr key={m.userId}>
                <th scope="row" className="px-5 py-2.5 text-left font-normal">
                  <span className="flex items-center gap-2.5">
                    <Avatar name={m.fullName} src={m.avatarUrl} className="size-7 text-[10px]" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{m.fullName}</span>
                      <span className="text-xs text-muted">{ROLE_LABELS[m.role]}</span>
                    </span>
                  </span>
                </th>
                <td className="px-2 py-2.5">
                  <span className="flex items-center gap-2">
                    <Num value={m.open} />
                    <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-surface-muted sm:block" aria-hidden>
                      <span className="block h-full rounded-full bg-work" style={{ width: `${(m.open / max) * 100}%` }} />
                    </span>
                  </span>
                </td>
                <td className="px-2 py-2.5"><Num value={m.inProgress} /></td>
                <td className="px-2 py-2.5"><Num value={m.dueToday} /></td>
                <td className="px-2 py-2.5"><Num value={m.overdue} danger /></td>
                <td className="px-5 py-2.5"><Num value={m.completedLast7Days} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.unassignedOpen > 0 && (
        <p className="border-t border-border px-5 py-3 text-sm">
          <span className="font-medium">{data.unassignedOpen}</span> open {data.unassignedOpen === 1 ? "task has" : "tasks have"} nobody assigned.{" "}
          <Link href={`/w/${workspaceId}/tasks`} className="text-work underline-offset-2 hover:underline">
            Review tasks
          </Link>
        </p>
      )}
    </Card>
  );
}

function ProjectProgress({ workspaceId }: { workspaceId: string }) {
  const { data } = useQuery<Project[]>(`/api/workspaces/${workspaceId}/projects`);
  const active = (data ?? []).filter((p) => p.status === "active" || p.status === "on_hold");
  return (
    <Card>
      <CardHeader title="Project progress" description="Tasks completed, per active project." />
      {!data ? (
        <Skeleton className="m-5 h-16" />
      ) : active.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted">No active projects.</p>
      ) : (
        <ul className="space-y-4 px-5 pb-5">
          {active.map((p) => {
            const pct = p.taskTotal ? Math.round((p.taskDone / p.taskTotal) * 100) : 0;
            return (
              <li key={p.id}>
                <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                  <Link href={`/w/${workspaceId}/tasks?projectId=${p.id}`} className="min-w-0 truncate font-medium hover:underline">
                    {p.name}
                  </Link>
                  <span className="shrink-0 text-xs text-muted">
                    {p.taskDone} of {p.taskTotal} · {pct}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${p.name} progress`}>
                  <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: p.color }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function RecentActivity({ workspaceId }: { workspaceId: string }) {
  const { profile } = useSession();
  const { openTask } = useTaskDialogs();
  const [limit, setLimit] = useState(25);
  const { data, error, reload } = useQuery<ActivityEntry[]>(`/api/workspaces/${workspaceId}/activity?limit=${limit}`);
  return (
    <Card>
      <CardHeader title="Recent activity" description="What has been happening in this workspace." />
      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !data ? (
        <Skeleton className="m-5 h-24" />
      ) : data.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted">Nothing yet.</p>
      ) : (
        <>
          <ol className="divide-y divide-border">
            {data.map((e) => {
              const line = describeFeedLine(e);
              return (
                <li key={e.id} className="px-5 py-2.5 text-sm">
                  <span className="font-medium">{e.actor?.fullName ?? "Someone"}</span> {line.lead}
                  {e.taskTitle && e.action !== "task.deleted" ? (
                    <>
                      {" "}
                      <button className="font-medium text-work hover:underline" onClick={() => e.entityId && openTask(e.entityId)}>
                        {e.taskTitle}
                      </button>
                    </>
                  ) : e.taskTitle ? (
                    <> “{e.taskTitle}”</>
                  ) : null}
                  {line.tail}
                  <span className="block text-xs text-muted">{when(e.createdAt, profile.timezone)}</span>
                </li>
              );
            })}
          </ol>
          {data.length >= limit && limit < 100 && (
            <div className="border-t border-border p-3 text-center">
              <Button size="sm" variant="ghost" onClick={() => setLimit(100)}>
                Show more
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export default function TeamView() {
  const { id } = useParams<{ id: string }>();
  const workspace = useWorkspace(id);
  const allowed = !!workspace && workspace.type === "organization" && canManage(workspace.role);
  const { data, error, reload } = useQuery<TeamOverview>(allowed ? `/api/workspaces/${id}/team` : null);

  if (!workspace) {
    return <EmptyState title="Workspace not found" description="It may have been deleted, or you are no longer a member." />;
  }
  if (!allowed) {
    return (
      <Card>
        <EmptyState
          title="Managers only"
          description={workspace.type === "organization" ? "The team overview is available to managers and admins." : "Team views only apply to organizations."}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="mt-1 text-sm text-muted">{workspace.name}</p>
      </div>
      {error ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : !data ? (
        <div className="space-y-4" aria-busy aria-label="Loading team">
          <Skeleton className="h-20" />
          <Skeleton className="h-56" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat icon={ListTodo} label="Open tasks" value={data.totals.open} tone="bg-work-soft text-work" />
            <Stat icon={AlertCircle} label="Overdue" value={data.totals.overdue} tone={data.totals.overdue ? "bg-danger-soft text-danger" : undefined} />
            <Stat icon={CheckCircle2} label="Done in the last 7 days" value={data.totals.completedLast7Days} tone="bg-personal-soft text-personal" />
            <Stat icon={UserX} label="Unassigned" value={data.unassignedOpen} tone={data.unassignedOpen ? "bg-warning-soft text-warning" : undefined} />
          </div>
          <Workload data={data} workspaceId={id} />
          <div className="grid gap-4 lg:grid-cols-2">
            <ProjectProgress workspaceId={id} />
            <RecentActivity workspaceId={id} />
          </div>
          <p className="text-xs text-muted">Counts exclude archived tasks. “Today” follows your time zone.</p>
        </>
      )}
    </div>
  );
}
