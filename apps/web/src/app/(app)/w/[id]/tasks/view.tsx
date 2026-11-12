"use client";

import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_SORTS,
  TASK_SORT_LABELS,
  TASK_STATUSES,
  type Member,
  type TaskListItem,
  type TaskStatus,
} from "@lifesync/shared";
import { Archive, CheckSquare, Columns3, List, Plus } from "lucide-react";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AssigneeAvatars } from "@/components/app/assignees";
import { canManage, useWorkspace } from "@/components/app/session";
import { useTaskDialogs } from "@/components/app/task-dialogs";
import { useWorkspaceMeta } from "@/components/app/task-form";
import { TaskRow, setTaskStatus } from "@/components/app/task-row";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, ErrorState, Skeleton } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { useQuery } from "@/lib/use-query";
import { cn, formatDay, formatTime } from "@/lib/utils";

const VIEW_KEY = "lifesync.tasks.view";

function BoardCard({ task, onOpen }: { task: TaskListItem; onOpen: () => void }) {
  const work = task.workspaceType === "organization";
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/task-id", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className="cursor-grab rounded-lg border border-border bg-surface p-3 shadow-card active:cursor-grabbing"
    >
      <button onClick={onOpen} className="block w-full text-left text-sm font-medium hover:underline">
        {task.title}
      </button>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        {task.dueDate && (
          <span>
            {formatDay(task.dueDate)}
            {task.dueTime && ` · ${formatTime(task.dueTime)}`}
          </span>
        )}
        {task.subtasksTotal > 0 && (
          <span>
            ☑ {task.subtasksDone}/{task.subtasksTotal}
          </span>
        )}
        {task.projectName && <span>▸ {task.projectName}</span>}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex gap-1.5">
          {(task.priority === "urgent" || task.priority === "high") && (
            <Badge tone={task.priority === "urgent" ? "danger" : "warning"}>{PRIORITY_LABELS[task.priority]}</Badge>
          )}
          {task.categoryName && <Badge tone={work ? "work" : "personal"}>{task.categoryName}</Badge>}
        </div>
        {work && <AssigneeAvatars assignees={task.assignees} />}
        <select
          aria-label={`Move ${task.title} to another column`}
          value={task.status}
          onChange={(e) => setTaskStatus(task, e.target.value as TaskStatus)}
          className="h-7 max-w-28 rounded-md border border-border bg-surface px-1 text-xs"
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
    </li>
  );
}

function Board({ tasks, byId }: { tasks: TaskListItem[]; byId: (id: string) => TaskListItem | undefined }) {
  const { openTask } = useTaskDialogs();
  const [over, setOver] = useState<TaskStatus | null>(null);
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {TASK_STATUSES.map((status) => {
        const col = tasks.filter((t) => t.status === status);
        return (
          <section
            key={status}
            aria-label={`${STATUS_LABELS[status]} column`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(status);
            }}
            onDragLeave={() => setOver((o) => (o === status ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const task = byId(e.dataTransfer.getData("text/task-id"));
              if (task && task.status !== status) void setTaskStatus(task, status);
            }}
            className={cn("rounded-xl bg-surface-muted p-3 transition-colors", over === status && "bg-work-soft ring-2 ring-work/40")}
          >
            <h2 className="mb-3 flex items-center justify-between text-sm font-semibold">
              {STATUS_LABELS[status]}
              <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-muted">{col.length}</span>
            </h2>
            <ul className="min-h-16 space-y-2">
              {col.map((t) => (
                <BoardCard key={t.id} task={t} onOpen={() => openTask(t.id)} />
              ))}
              {col.length === 0 && <li className="px-1 py-3 text-center text-xs text-muted">Drop a task here</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function Tasks({ initialQ, initialProject }: { initialQ: string; initialProject: string }) {
  const { id } = useParams<{ id: string }>();
  const workspace = useWorkspace(id);
  const { openCreate } = useTaskDialogs();
  const { projects, categories } = useWorkspaceMeta(id);
  const [view, setView] = useState<"list" | "board">(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "board" ? "board" : "list";
    } catch {
      return "list";
    }
  });
  const [q, setQ] = useState(initialQ);
  const [debounced, setDebounced] = useState(initialQ);
  const [status, setStatus] = useState("open");
  const [priority, setPriority] = useState("");
  const [projectId, setProjectId] = useState(initialProject);
  const [categoryId, setCategoryId] = useState("");
  const [sort, setSort] = useState("due");
  const [archived, setArchived] = useState(false);
  const [assignee, setAssignee] = useState("");
  const isOrg = workspace?.type === "organization";
  const manager = !!workspace && canManage(workspace.role);
  const people = useQuery<Member[]>(isOrg && manager ? `/api/workspaces/${id}/members` : null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const board = view === "board" && !archived;
  const query = new URLSearchParams({ workspaceId: id, sort });
  if (archived) query.set("archived", "true");
  else if (!board && status) query.set("status", status);
  if (priority) query.set("priority", priority);
  if (projectId) query.set("projectId", projectId);
  if (categoryId) query.set("categoryId", categoryId);
  if (assignee && manager) query.set("assignee", assignee);
  if (debounced.trim()) query.set("q", debounced.trim());
  const { data, error, loading, reload } = useQuery<TaskListItem[]>(`/api/tasks?${query}`);

  const changeView = (v: "list" | "board") => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };

  if (!workspace) {
    return (
      <Card>
        <EmptyState title="Workspace not found" />
      </Card>
    );
  }
  const filtered = !!priority || !!projectId || !!categoryId || !!debounced.trim() || (!board && status !== "open" && status !== "");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{archived ? "Archived tasks" : "Tasks"}</h1>
          <p className="mt-1 text-sm text-muted">{workspace.type === "personal" ? "Personal" : workspace.name}</p>
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="View" className="flex rounded-lg border border-border bg-surface p-0.5">
            {([["list", List, "List"], ["board", Columns3, "Board"]] as const).map(([v, Icon, label]) => (
              <button
                key={v}
                onClick={() => changeView(v)}
                aria-pressed={view === v}
                className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm", view === v ? "bg-surface-muted font-medium" : "text-muted")}
              >
                <Icon className="size-4" /> {label}
              </button>
            ))}
          </div>
          <Button onClick={() => openCreate(id)}>
            <Plus /> Add task
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Input className="w-full max-w-xs" placeholder="Search tasks…" aria-label="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} />
        {!board && !archived && (
          <Select className="w-40" aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open</option>
            <option value="">All statuses</option>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        )}
        <Select className="w-36" aria-label="Filter by priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">Any priority</option>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </Select>
        <Select className="w-40" aria-label="Filter by project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select className="w-40" aria-label="Filter by category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {isOrg && manager && (
          <Select className="w-44" aria-label="Filter by assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="none">Unassigned</option>
            {(people.data ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.fullName}
              </option>
            ))}
          </Select>
        )}
        <Select className="w-40" aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value)}>
          {TASK_SORTS.map((s) => (
            <option key={s} value={s}>
              Sort: {TASK_SORT_LABELS[s]}
            </option>
          ))}
        </Select>
        <Button variant={archived ? "primary" : "outline"} aria-pressed={archived} onClick={() => setArchived((a) => !a)}>
          <Archive /> Archived
        </Button>
      </div>

      {loading && !data ? (
        <Card className="space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </Card>
      ) : error ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : data && board ? (
        <Board tasks={data} byId={(tid) => data.find((t) => t.id === tid)} />
      ) : data && data.length === 0 ? (
        <Card>
          <EmptyState
            icon={archived ? <Archive /> : <CheckSquare />}
            title={archived ? "Nothing archived" : filtered ? "No tasks match" : "No tasks yet"}
            description={archived ? "Archived tasks stay out of your way but can be restored." : filtered ? "Try different filters or search words." : "Add your first task to get started."}
            action={
              !filtered &&
              !archived && (
                <Button size="sm" onClick={() => openCreate(id)}>
                  <Plus /> Add a task
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <Card className="py-1">
          <ul className="divide-y divide-border">
            {data?.map((t) => (
              <TaskRow key={t.id} task={t} showDate />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Re-keyed by the URL filters so a top-bar search or a link from Projects resets the page state. */
function TasksFromUrl() {
  const params = useSearchParams();
  const q = params.get("q") ?? "";
  const project = params.get("projectId") ?? "";
  return <Tasks key={`${q}|${project}`} initialQ={q} initialProject={project} />;
}

export default function TasksPage() {
  return (
    <Suspense>
      <TasksFromUrl />
    </Suspense>
  );
}
