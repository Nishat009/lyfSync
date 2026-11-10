"use client";

import {
  PRIORITY_LABELS,
  REMINDER_OFFSET_LABELS,
  STATUS_LABELS,
  addDays,
  describeRecurrence,
  localDate,
  localTime,
  type Subtask,
  type TaskDetail,
  type TaskReminder,
} from "@lifesync/shared";
import { Archive, ArchiveRestore, Bell, CalendarClock, Check, Copy, Pencil, Plus, Repeat, Trash2, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, createContext, useContext, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, ErrorState, Skeleton } from "@/components/ui/card";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/form";
import { api } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/use-query";
import { cn, formatDay, formatTime } from "@/lib/utils";
import { useSession } from "./session";
import { TaskForm } from "./task-form";

export interface Prefill {
  dueDate?: string;
  dueTime?: string;
}

type View = { kind: "detail"; id: string } | { kind: "edit"; id: string } | { kind: "create"; workspaceId?: string; prefill?: Prefill } | null;

interface Api {
  openTask: (id: string) => void;
  openCreate: (workspaceId?: string, prefill?: Prefill) => void;
}

/** Opens a task when the URL carries ?task=<id> (links in notifications and emails), then tidies the URL. */
function TaskLinkOpener({ open }: { open: (id: string) => void }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const id = params.get("task");
  // The URL is cleaned asynchronously, so remember what was already opened or this would loop.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!id) {
      handled.current = null;
      return;
    }
    if (handled.current === id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    handled.current = id;
    open(id);
    const rest = new URLSearchParams(params.toString());
    rest.delete("task");
    router.replace(rest.size ? `${pathname}?${rest}` : pathname);
  }, [id, open, params, pathname, router]);
  return null;
}
const Ctx = createContext<Api>({ openTask: () => {}, openCreate: () => {} });
export const useTaskDialogs = () => useContext(Ctx);

export function TaskDialogsProvider({ children }: { children: React.ReactNode }) {
  const [view, setView] = useState<View>(null);
  const close = () => setView(null);
  return (
    <Ctx.Provider
      value={{
        openTask: (id) => setView({ kind: "detail", id }),
        openCreate: (workspaceId, prefill) => setView({ kind: "create", workspaceId, prefill }),
      }}
    >
      {children}
      <Suspense>
        <TaskLinkOpener open={(id) => setView({ kind: "detail", id })} />
      </Suspense>
      <Dialog open={view?.kind === "detail"} onOpenChange={(o) => !o && close()}>
        <DialogContent title="Task" className="max-w-xl">
          {view?.kind === "detail" && <TaskDetailView id={view.id} onClose={close} onEdit={() => setView({ kind: "edit", id: view.id })} />}
        </DialogContent>
      </Dialog>
      <Dialog open={view?.kind === "edit" || view?.kind === "create"} onOpenChange={(o) => !o && close()}>
        <DialogContent
          title={view?.kind === "edit" ? "Edit task" : "New task"}
          className="max-w-2xl"
        >
          {view?.kind === "create" && <TaskForm defaultWorkspaceId={view.workspaceId} prefill={view.prefill} onDone={close} />}
          {view?.kind === "edit" && <EditLoader id={view.id} onDone={() => setView({ kind: "detail", id: view.id })} />}
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}

function EditLoader({ id, onDone }: { id: string; onDone: () => void }) {
  const { data, error, reload } = useQuery<TaskDetail>(`/api/tasks/${id}`);
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <Skeleton className="h-64" />;
  return <TaskForm task={data} onDone={onDone} />;
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

function Checklist({ task }: { task: TaskDetail }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/tasks/${task.id}/subtasks`;
  const refresh = () => {
    invalidate("/api/tasks");
  };
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    }
  };
  const done = task.subtasks.filter((s) => s.isDone).length;

  return (
    <section aria-label="Checklist">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Checklist</h3>
        {task.subtasks.length > 0 && (
          <span className="text-xs text-muted">
            {done}/{task.subtasks.length} done
          </span>
        )}
      </div>
      <ul className="space-y-1">
        {task.subtasks.map((s: Subtask) => (
          <li key={s.id} className="group flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-surface-muted">
            <button
              role="checkbox"
              aria-checked={s.isDone}
              aria-label={`${s.isDone ? "Uncheck" : "Check"} ${s.title}`}
              onClick={() => run(() => api(`${base}/${s.id}`, { method: "PATCH", body: { isDone: !s.isDone } }))}
              className={cn(
                "grid size-4 shrink-0 place-items-center rounded border",
                s.isDone ? "border-personal bg-personal text-white" : "border-border bg-surface",
              )}
            >
              {s.isDone && <Check className="size-3" />}
            </button>
            <span className={cn("flex-1 text-sm", s.isDone && "text-muted line-through")}>{s.title}</span>
            <button
              aria-label={`Remove ${s.title}`}
              onClick={() => run(() => api(`${base}/${s.id}`, { method: "DELETE" }))}
              className="rounded p-1 text-muted opacity-0 hover:text-danger focus:opacity-100 group-hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          setBusy(true);
          await run(() => api(base, { body: { title: text.trim() } }));
          setText("");
          setBusy(false);
        }}
      >
        <Input aria-label="Add checklist item" placeholder="Add an item…" value={text} onChange={(e) => setText(e.target.value)} className="h-9" />
        <Button type="submit" size="sm" variant="outline" loading={busy}>
          <Plus /> Add
        </Button>
      </form>
    </section>
  );
}

function ReminderSummary({ taskId }: { taskId: string }) {
  const { profile } = useSession();
  const { data } = useQuery<TaskReminder[]>(`/api/tasks/${taskId}/reminders`);
  const pending = (data ?? []).filter((r) => r.status === "pending");
  if (!pending.length) return null;
  return (
    <section aria-label="Reminders">
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
        <Bell className="size-3.5" aria-hidden /> Reminders
      </h3>
      <ul className="flex flex-wrap gap-1.5">
        {pending.map((r) => {
          const when = new Date(r.remindAt);
          const label =
            r.offsetMinutes !== null
              ? REMINDER_OFFSET_LABELS[r.offsetMinutes as keyof typeof REMINDER_OFFSET_LABELS] ?? `${r.offsetMinutes} min before`
              : "Custom";
          return (
            <li key={r.id}>
              <Badge>
                {label} · {formatDay(localDate(when, profile.timezone))}, {formatTime(localTime(when, profile.timezone))}
              </Badge>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TaskDetailView({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: () => void }) {
  const { profile } = useSession();
  const { data: task, error, reload } = useQuery<TaskDetail>(`/api/tasks/${id}`);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!task) return <Skeleton className="h-64" />;

  const work = task.workspaceType === "organization";
  const patch = async (body: object, message?: string) => {
    try {
      await api(`/api/tasks/${id}`, { method: "PATCH", body });
      invalidate("/api/tasks");
      invalidate("/api/dashboard");
      if (message) toast.success(message);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the task");
    }
  };
  const act = async (path: string, message: string, after?: () => void) => {
    try {
      await api(`/api/tasks/${id}/${path}`, { method: "POST", body: {} });
      invalidate("/api/tasks");
      invalidate("/api/dashboard");
      toast.success(message);
      after?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    }
  };
  const today = () => localDate(Date.now(), profile.timezone);
  const completed = task.status === "completed";

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={work ? "work" : "personal"}>{work ? task.workspaceName : "Personal"}</Badge>
          <Badge tone={task.status === "completed" ? "personal" : "neutral"}>{STATUS_LABELS[task.status]}</Badge>
          {task.archived && <Badge tone="warning">Archived</Badge>}
        </div>
        <h2 className={cn("mt-2 text-lg font-semibold leading-snug", completed && "text-muted line-through")}>{task.title}</h2>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={completed ? "outline" : work ? "work" : "personal"} onClick={() => patch({ status: completed ? "todo" : "completed" }, completed ? "Task reopened" : "Task completed")}>
          <Check /> {completed ? "Reopen" : "Complete"}
        </Button>
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Pencil /> Edit
        </Button>
        <Button size="sm" variant="outline" onClick={() => act("duplicate", "Task duplicated", onClose)}>
          <Copy /> Duplicate
        </Button>
        <Button size="sm" variant="outline" onClick={() => act(task.archived ? "unarchive" : "archive", task.archived ? "Task restored" : "Task archived", onClose)}>
          {task.archived ? <ArchiveRestore /> : <Archive />} {task.archived ? "Restore" : "Archive"}
        </Button>
        <Button size="sm" variant="ghost" className="text-danger hover:bg-danger-soft" onClick={() => setConfirmDelete(true)}>
          <Trash2 /> Delete
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Meta label="Priority">{PRIORITY_LABELS[task.priority]}</Meta>
        <Meta label="Due">
          {task.dueDate ? `${formatDay(task.dueDate)}${task.dueTime ? ` · ${formatTime(task.dueTime)}` : ""}` : "No due date"}
        </Meta>
        <Meta label="Start">
          {task.startDate ? `${formatDay(task.startDate)}${task.startTime ? ` · ${formatTime(task.startTime)}` : ""}` : "—"}
        </Meta>
        <Meta label="Project">{task.projectName ?? "—"}</Meta>
        <Meta label="Category">{task.categoryName ?? "—"}</Meta>
        <Meta label="Time">
          {task.estimatedMinutes ? `${task.estimatedMinutes} min est.` : "—"}
          {task.actualMinutes > 0 && ` · ${task.actualMinutes} min spent`}
        </Meta>
        {task.assignees.length > 0 && <Meta label="Assigned to">{task.assignees.map((a) => a.fullName).join(", ")}</Meta>}
        <Meta label="Created">
          {task.createdByName ?? "Someone"}, {formatDay(task.createdAt.slice(0, 10))}
        </Meta>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-xs text-muted">
          <CalendarClock className="size-3.5" aria-hidden /> Reschedule
        </span>
        <Button size="sm" variant="outline" onClick={() => patch({ dueDate: today() }, "Moved to today")}>
          Today
        </Button>
        <Button size="sm" variant="outline" onClick={() => patch({ dueDate: addDays(today(), 1) }, "Moved to tomorrow")}>
          Tomorrow
        </Button>
        <Button size="sm" variant="outline" onClick={() => patch({ dueDate: addDays(today(), 7) }, "Moved to next week")}>
          Next week
        </Button>
        <Input
          type="date"
          aria-label="Pick a new due date"
          className="h-8 w-auto"
          value={task.dueDate ?? ""}
          onChange={(e) => e.target.value && patch({ dueDate: e.target.value }, "Rescheduled")}
        />
      </div>

      {task.recurrence && (
        <p className="flex items-center gap-1.5 text-sm text-muted">
          <Repeat className="size-4" aria-hidden /> {describeRecurrence(task.recurrence)}
        </p>
      )}
      <ReminderSummary taskId={task.id} />

      {task.tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
          {task.tags.map((t) => (
            <li key={t}>
              <Badge>#{t}</Badge>
            </li>
          ))}
        </ul>
      )}
      {task.description && <p className="whitespace-pre-wrap text-sm">{task.description}</p>}

      <Checklist task={task} />

      {task.notes && (
        <section aria-label="Notes">
          <h3 className="mb-1 text-sm font-semibold">Notes</h3>
          <p className="whitespace-pre-wrap rounded-lg bg-surface-muted p-3 text-sm">{task.notes}</p>
        </section>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this task?"
        description="It will be permanently removed along with its checklist. Archive it instead if you may need it later."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          try {
            await api(`/api/tasks/${id}`, { method: "DELETE" });
            // Close first so this dialog does not refetch the task it just deleted.
            flushSync(onClose);
            invalidate("/api/tasks");
            invalidate("/api/dashboard");
            toast.success("Task deleted");
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not delete the task");
            throw e;
          }
        }}
      />
    </div>
  );
}
