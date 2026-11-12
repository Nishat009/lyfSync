"use client";

import { PRIORITY_LABELS, type TaskListItem, type TaskPriority, type TaskSummary } from "@lifesync/shared";
import { Check, Clock, ListChecks } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/card";
import { api } from "@/lib/api";
import { invalidate } from "@/lib/use-query";
import { cn, formatDay, formatTime } from "@/lib/utils";
import { AssigneeAvatars } from "./assignees";
import { useTaskDialogs } from "./task-dialogs";

const priorityTone: Record<TaskPriority, "danger" | "warning" | "neutral"> = {
  urgent: "danger",
  high: "warning",
  medium: "neutral",
  low: "neutral",
};

export async function setTaskStatus(task: TaskSummary, status: TaskSummary["status"]) {
  try {
    await api(`/api/tasks/${task.id}/status`, { method: "PATCH", body: { status } });
    invalidate("/api/dashboard");
    invalidate("/api/tasks");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Could not update the task");
  }
}

export function TaskRow({
  task,
  showWorkspace,
  showDate,
  actions,
}: {
  task: TaskSummary | TaskListItem;
  showWorkspace?: boolean;
  showDate?: boolean;
  actions?: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const { openTask } = useTaskDialogs();
  const extra = "tags" in task ? task : null;
  const done = task.status === "completed";
  const cancelled = task.status === "cancelled";
  const work = task.workspaceType === "organization";

  return (
    <li className="flex items-center gap-3 px-5 py-2.5">
      <button
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        disabled={busy || cancelled}
        onClick={async () => {
          setBusy(true);
          await setTaskStatus(task, done ? "todo" : "completed");
          setBusy(false);
        }}
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full border transition-colors disabled:opacity-50",
          done ? (work ? "border-work bg-work text-white" : "border-personal bg-personal text-white") : "border-border hover:border-muted",
        )}
      >
        {done && <Check className="size-3" />}
      </button>
      <div className="min-w-0 flex-1">
        <button
          onClick={() => openTask(task.id)}
          className={cn("block max-w-full truncate text-left text-sm hover:underline", (done || cancelled) && "text-muted line-through")}
        >
          {task.title}
        </button>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
          {showDate && task.dueDate && <span>{formatDay(task.dueDate)}</span>}
          {task.dueTime && (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" aria-hidden />
              {formatTime(task.dueTime)}
            </span>
          )}
          {task.categoryName && <span>{task.categoryName}</span>}
          {extra?.projectName && <span>▸ {extra.projectName}</span>}
          {extra && extra.subtasksTotal > 0 && (
            <span className="inline-flex items-center gap-1">
              <ListChecks className="size-3" aria-hidden />
              {extra.subtasksDone}/{extra.subtasksTotal}
            </span>
          )}
          {extra?.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </p>
      </div>
      {showWorkspace && (
        <Badge tone={work ? "work" : "personal"} className="hidden max-w-32 truncate sm:inline-flex">
          {work ? task.workspaceName : "Personal"}
        </Badge>
      )}
      {(task.priority === "urgent" || task.priority === "high") && (
        <Badge tone={priorityTone[task.priority]}>{PRIORITY_LABELS[task.priority]}</Badge>
      )}
      {work && extra && <AssigneeAvatars assignees={extra.assignees} />}
      {actions}
    </li>
  );
}
