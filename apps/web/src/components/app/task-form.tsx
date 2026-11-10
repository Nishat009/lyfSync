"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  LIMITS,
  PRIORITY_LABELS,
  REMINDER_OFFSETS,
  REMINDER_OFFSET_LABELS,
  STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  checkTaskDates,
  localDate,
  localTime,
  zonedToUtc,
  type Category,
  type NotificationPreferences,
  type Project,
  type TaskDetail,
  type TaskReminder,
  type WorkspaceDetail,
} from "@lifesync/shared";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/card";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { api, applyFormError } from "@/lib/api";
import { PRESET_LABELS, buildRecurrence, fieldsOf, type Preset } from "@/lib/recurrence-ui";
import { invalidate, useQuery } from "@/lib/use-query";
import { cn } from "@/lib/utils";
import { useSession } from "./session";

/** Projects and categories of one workspace, for the pickers. */
export function useWorkspaceMeta(workspaceId: string | null) {
  const ws = useQuery<WorkspaceDetail>(workspaceId ? `/api/workspaces/${workspaceId}` : null);
  const projects = useQuery<Project[]>(workspaceId ? `/api/workspaces/${workspaceId}/projects` : null);
  return {
    categories: (ws.data?.categories ?? []) as Category[],
    projects: projects.data ?? [],
  };
}

const schema = z
  .object({
    workspaceId: z.string().min(1, { error: "Choose a workspace" }),
    title: z.string().trim().min(1, { error: "Give the task a title" }).max(LIMITS.taskTitleMax),
    description: z.string().max(10000),
    notes: z.string().max(20000),
    priority: z.enum(TASK_PRIORITIES),
    status: z.enum(TASK_STATUSES),
    projectId: z.string(),
    categoryId: z.string(),
    startDate: z.string(),
    startTime: z.string(),
    dueDate: z.string(),
    dueTime: z.string(),
    estimate: z.string().regex(/^\d*$/, { error: "Use whole minutes" }),
    actual: z.string().regex(/^\d*$/, { error: "Use whole minutes" }),
    tags: z.string().max(400),
    preset: z.enum(["none", "daily", "weekday", "weekly", "monthly", "yearly", "custom"]),
    interval: z.string().regex(/^\d+$/, { error: "Use a whole number" }),
    unit: z.enum(["daily", "weekly", "monthly", "yearly"]),
    weekdays: z.array(z.string()),
    endMode: z.enum(["never", "on", "count"]),
    endsOn: z.string(),
    maxCount: z.string().regex(/^\d*$/, { error: "Use a whole number" }),
  })
  .superRefine(checkTaskDates)
  .superRefine((v, ctx) => {
    if (v.preset !== "none" && !v.dueDate) ctx.addIssue({ code: "custom", message: "Repeating tasks need a due date", path: ["dueDate"] });
    if (v.preset === "custom" && v.unit === "weekly" && v.weekdays.length === 0) {
      ctx.addIssue({ code: "custom", message: "Pick at least one weekday", path: ["weekdays"] });
    }
    if (v.endMode === "on" && !v.endsOn) ctx.addIssue({ code: "custom", message: "Choose an end date", path: ["endsOn"] });
    if (v.endMode === "count" && !v.maxCount) ctx.addIssue({ code: "custom", message: "Enter how many times", path: ["maxCount"] });
  });
type Values = z.infer<typeof schema>;

const emptyToNull = (s: string) => (s.trim() === "" ? null : s.trim());

function parseTags(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean);
}

interface ReminderChoice {
  offsets: number[];
  /** "YYYY-MM-DDTHH:mm" in the person's time zone. */
  custom: string[];
}

function RemindersField({ value, onChange, hasDueTime }: { value: ReminderChoice; onChange: (v: ReminderChoice) => void; hasDueTime: boolean }) {
  const [draft, setDraft] = useState("");
  return (
    <fieldset className="space-y-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium">Reminders</legend>
      {!hasDueTime && <p className="text-xs text-muted">Set a due time to use “before” reminders. You can still add a custom reminder below.</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {REMINDER_OFFSETS.map((o) => (
          <label key={o} className={cn("flex items-center gap-2 text-sm", !hasDueTime && "opacity-50")}>
            <input
              type="checkbox"
              className="size-4 accent-[var(--work)]"
              disabled={!hasDueTime}
              checked={value.offsets.includes(o)}
              onChange={(e) => onChange({ ...value, offsets: e.target.checked ? [...value.offsets, o] : value.offsets.filter((x) => x !== o) })}
            />
            {REMINDER_OFFSET_LABELS[o]}
          </label>
        ))}
      </div>
      <div>
        <p className="mb-1.5 text-xs text-muted">Custom date and time</p>
        <ul className="mb-2 flex flex-wrap gap-2">
          {value.custom.map((c) => (
            <li key={c} className="flex items-center gap-1 rounded-full bg-surface-muted py-1 pl-3 pr-1 text-xs">
              {c.replace("T", " ")}
              <button type="button" aria-label={`Remove reminder ${c}`} onClick={() => onChange({ ...value, custom: value.custom.filter((x) => x !== c) })} className="rounded-full p-1 hover:bg-border">
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Input type="datetime-local" aria-label="Custom reminder time" className="h-9" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <Button
            size="sm"
            variant="outline"
            disabled={!draft}
            onClick={() => {
              if (draft && !value.custom.includes(draft)) onChange({ ...value, custom: [...value.custom, draft] });
              setDraft("");
            }}
          >
            <Plus /> Add
          </Button>
        </div>
      </div>
    </fieldset>
  );
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Create or edit a task. Loads what it needs first, then mounts fresh each time its dialog opens. */
export function TaskForm({
  task,
  defaultWorkspaceId,
  prefill,
  onDone,
}: {
  task?: TaskDetail;
  defaultWorkspaceId?: string;
  prefill?: { dueDate?: string; dueTime?: string };
  onDone: (saved?: { id: string }) => void;
}) {
  const { profile } = useSession();
  const prefs = useQuery<NotificationPreferences>("/api/notification-preferences");
  const existing = useQuery<TaskReminder[]>(task ? `/api/tasks/${task.id}/reminders` : null);
  const failed = prefs.error ?? existing.error;
  if (failed) return <ErrorState message={failed.message} onRetry={() => { void prefs.reload(); void existing.reload(); }} />;
  if (!prefs.data || (task && !existing.data)) return <Skeleton className="h-72" />;

  const tz = profile.timezone;
  const initialReminders: ReminderChoice = task
    ? {
        offsets: (existing.data ?? []).filter((r) => r.status === "pending" && r.offsetMinutes !== null).map((r) => r.offsetMinutes as number),
        custom: (existing.data ?? [])
          .filter((r) => r.status === "pending" && r.offsetMinutes === null)
          .map((r) => `${localDate(new Date(r.remindAt), tz)}T${localTime(new Date(r.remindAt), tz)}`),
      }
    : { offsets: prefs.data.defaultReminderOffsets, custom: [] };

  return <TaskFormInner task={task} defaultWorkspaceId={defaultWorkspaceId} prefill={prefill} initialReminders={initialReminders} onDone={onDone} />;
}

function TaskFormInner({
  task,
  defaultWorkspaceId,
  prefill,
  initialReminders,
  onDone,
}: {
  task?: TaskDetail;
  defaultWorkspaceId?: string;
  prefill?: { dueDate?: string; dueTime?: string };
  initialReminders: ReminderChoice;
  onDone: (saved?: { id: string }) => void;
}) {
  const { workspaces, profile } = useSession();
  const [formError, setFormError] = useState<string | null>(null);
  const [reminders, setReminders] = useState<ReminderChoice>(initialReminders);
  const [defaults] = useState<Values>(() => {
    const rec = fieldsOf(task?.recurrence ?? null);
    return task
      ? {
          workspaceId: task.workspaceId,
          title: task.title,
          description: task.description ?? "",
          notes: task.notes ?? "",
          priority: task.priority,
          status: task.status,
          projectId: task.projectId ?? "",
          categoryId: task.categoryId ?? "",
          startDate: task.startDate ?? "",
          startTime: task.startTime ?? "",
          dueDate: task.dueDate ?? "",
          dueTime: task.dueTime ?? "",
          estimate: task.estimatedMinutes?.toString() ?? "",
          actual: task.actualMinutes ? String(task.actualMinutes) : "",
          tags: task.tags.join(", "),
          ...rec,
        }
      : {
          workspaceId:
            workspaces.find((w) => w.id === defaultWorkspaceId)?.id ?? workspaces.find((w) => w.type === "personal")?.id ?? "",
          title: "",
          description: "",
          notes: "",
          priority: "medium",
          status: "todo",
          projectId: "",
          categoryId: "",
          startDate: "",
          startTime: "",
          dueDate: prefill?.dueDate ?? localDate(Date.now(), profile.timezone),
          dueTime: prefill?.dueTime ?? "",
          estimate: "",
          actual: "",
          tags: "",
          ...rec,
        };
  });

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    control,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults });

  const workspaceId = useWatch({ control, name: "workspaceId" });
  const dueTime = useWatch({ control, name: "dueTime" });
  const preset = useWatch({ control, name: "preset" });
  const unit = useWatch({ control, name: "unit" });
  const endMode = useWatch({ control, name: "endMode" });
  const { projects, categories } = useWorkspaceMeta(workspaceId || null);

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={handleSubmit(async (v) => {
        setFormError(null);
        const body = {
          title: v.title,
          description: emptyToNull(v.description),
          notes: emptyToNull(v.notes),
          priority: v.priority,
          status: v.status,
          projectId: v.projectId || null,
          categoryId: v.categoryId || null,
          startDate: v.startDate || null,
          startTime: v.startTime || null,
          dueDate: v.dueDate || null,
          dueTime: v.dueTime || null,
          estimatedMinutes: v.estimate ? Number(v.estimate) : null,
          actualMinutes: v.actual ? Number(v.actual) : 0,
          tags: parseTags(v.tags),
          recurrence: buildRecurrence(v),
        };
        let saved: { id: string };
        try {
          saved = task
            ? await api<TaskDetail>(`/api/tasks/${task.id}`, { method: "PATCH", body })
            : await api<{ id: string }>("/api/tasks", { body: { ...body, workspaceId: v.workspaceId } });
        } catch (e) {
          setFormError(applyFormError(e, setError));
          return;
        }
        // Reminders are saved separately; the task itself is already safe if this step fails.
        try {
          const res = await api<{ skipped: number }>(`/api/tasks/${saved.id}/reminders`, {
            method: "PUT",
            body: {
              offsets: v.dueTime ? reminders.offsets : [],
              custom: reminders.custom.map((c) => zonedToUtc(c.slice(0, 10), c.slice(11, 16), profile.timezone).toISOString()),
            },
          });
          if (res.skipped) toast.info(`${res.skipped} reminder${res.skipped === 1 ? " was" : "s were"} skipped because that time has passed`);
        } catch (e) {
          toast.error(`Task saved, but reminders were not: ${e instanceof Error ? e.message : "unknown error"}`);
        }
        invalidate("/api/tasks");
        invalidate("/api/dashboard");
        invalidate("/api/reminders");
        invalidate("/api/calendar");
        invalidate("/api/workspaces");
        toast.success(task ? "Task saved" : "Task added");
        onDone(saved);
      })}
    >
      <FormError message={formError} />
      <Field label="Title" error={errors.title?.message}>
        {(p) => <Input autoFocus placeholder="What needs doing?" {...p} {...register("title")} />}
      </Field>
      <Field label="Description" error={errors.description?.message}>
        {(p) => <Textarea rows={3} {...p} {...register("description")} />}
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Workspace" error={errors.workspaceId?.message}>
          {(p) => (
            <Select
              {...p}
              disabled={!!task}
              {...register("workspaceId", {
                onChange: () => {
                  setValue("projectId", "");
                  setValue("categoryId", "");
                },
              })}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.type === "personal" ? "Personal" : w.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Project" error={errors.projectId?.message}>
          {(p) => (
            <Select {...p} {...register("projectId")}>
              <option value="">No project</option>
              {projects
                .filter((x) => x.status !== "archived" || x.id === defaults.projectId)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Category">
          {(p) => (
            <Select {...p} {...register("categoryId")}>
              <option value="">No category</option>
              {categories.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Priority">
          {(p) => (
            <Select {...p} {...register("priority")}>
              {TASK_PRIORITIES.map((x) => (
                <option key={x} value={x}>
                  {PRIORITY_LABELS[x]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Status">
          {(p) => (
            <Select {...p} {...register("status")}>
              {TASK_STATUSES.map((x) => (
                <option key={x} value={x}>
                  {STATUS_LABELS[x]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Tags" hint="Separate with commas" error={errors.tags?.message}>
          {(p) => <Input placeholder="home, urgent" {...p} {...register("tags")} />}
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Start date" error={errors.startDate?.message}>
          {(p) => <Input type="date" {...p} {...register("startDate")} />}
        </Field>
        <Field label="Start time" error={errors.startTime?.message}>
          {(p) => <Input type="time" {...p} {...register("startTime")} />}
        </Field>
        <Field label="Due date" error={errors.dueDate?.message}>
          {(p) => <Input type="date" {...p} {...register("dueDate")} />}
        </Field>
        <Field label="Due time" error={errors.dueTime?.message}>
          {(p) => <Input type="time" {...p} {...register("dueTime")} />}
        </Field>
      </div>

      <fieldset className="space-y-3 rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium">Repeat</legend>
        <Field label="Repeats">
          {(p) => (
            <Select {...p} {...register("preset")}>
              {(Object.keys(PRESET_LABELS) as Preset[]).map((k) => (
                <option key={k} value={k}>
                  {PRESET_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {preset === "custom" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Every" error={errors.interval?.message}>
                {(p) => <Input inputMode="numeric" {...p} {...register("interval")} />}
              </Field>
              <Field label="Unit">
                {(p) => (
                  <Select {...p} {...register("unit")}>
                    <option value="daily">day(s)</option>
                    <option value="weekly">week(s)</option>
                    <option value="monthly">month(s)</option>
                    <option value="yearly">year(s)</option>
                  </Select>
                )}
              </Field>
            </div>
            {unit === "weekly" && (
              <div>
                <p className="mb-1.5 text-sm font-medium">On</p>
                <div className="flex flex-wrap gap-2">
                  {DAY_NAMES.map((d, i) => (
                    <label key={d} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm has-[:checked]:border-work has-[:checked]:bg-work-soft">
                      <input type="checkbox" value={String(i)} className="size-3.5 accent-[var(--work)]" {...register("weekdays")} />
                      {d}
                    </label>
                  ))}
                </div>
                {errors.weekdays?.message && (
                  <p role="alert" className="mt-1 text-xs text-danger">
                    {errors.weekdays.message}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
        {preset !== "none" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Ends">
              {(p) => (
                <Select {...p} {...register("endMode")}>
                  <option value="never">Never</option>
                  <option value="on">On a date</option>
                  <option value="count">After a number of times</option>
                </Select>
              )}
            </Field>
            {endMode === "on" && (
              <Field label="End date" error={errors.endsOn?.message}>
                {(p) => <Input type="date" {...p} {...register("endsOn")} />}
              </Field>
            )}
            {endMode === "count" && (
              <Field label="Times" error={errors.maxCount?.message}>
                {(p) => <Input inputMode="numeric" {...p} {...register("maxCount")} />}
              </Field>
            )}
          </div>
        )}
        {preset !== "none" && <p className="text-xs text-muted">The next one is created when you complete or cancel this one.</p>}
      </fieldset>

      <RemindersField value={reminders} onChange={setReminders} hasDueTime={!!dueTime} />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Estimated (minutes)" error={errors.estimate?.message}>
          {(p) => <Input inputMode="numeric" {...p} {...register("estimate")} />}
        </Field>
        <Field label="Actual (minutes)" error={errors.actual?.message}>
          {(p) => <Input inputMode="numeric" {...p} {...register("actual")} />}
        </Field>
      </div>

      <Field label="Notes" error={errors.notes?.message}>
        {(p) => <Textarea rows={3} {...p} {...register("notes")} />}
      </Field>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button type="submit" loading={isSubmitting}>
          {task ? "Save changes" : "Add task"}
        </Button>
      </div>
    </form>
  );
}
