"use client";

import { habitSchema, type Habit } from "@lifesync/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Flame, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useWorkspace } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, Skeleton } from "@/components/ui/card";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, FormError, Input, Textarea } from "@/components/ui/form";
import { api, applyFormError } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/use-query";
import { cn } from "@/lib/utils";

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const formSchema = habitSchema.extend({ description: z.string().max(500), targetPerDay: z.number().int().min(1).max(100) });
type Values = z.infer<typeof formSchema>;

function HabitForm({ workspaceId, habit, onDone }: { workspaceId: string; habit?: Habit; onDone: () => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: habit?.name ?? "",
      description: habit?.description ?? "",
      byWeekday: habit?.byWeekday ?? [0, 1, 2, 3, 4, 5, 6],
      targetPerDay: habit?.targetPerDay ?? 1,
    },
  });
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={handleSubmit(async (v) => {
        setFormError(null);
        const body = { ...v, description: v.description.trim() || null };
        try {
          if (habit) await api(`/api/habits/${habit.id}`, { method: "PATCH", body });
          else await api(`/api/workspaces/${workspaceId}/habits`, { body });
          invalidate("/api/workspaces");
          invalidate("/api/analytics");
          toast.success(habit ? "Habit saved" : "Habit added");
          onDone();
        } catch (e) {
          setFormError(applyFormError(e, setError));
        }
      })}
    >
      <FormError message={formError} />
      <Field label="Habit" error={errors.name?.message}>
        {(p) => <Input autoFocus placeholder="Read for 20 minutes" {...p} {...register("name")} />}
      </Field>
      <Field label="Notes (optional)" error={errors.description?.message}>
        {(p) => <Textarea rows={2} {...p} {...register("description")} />}
      </Field>
      <Controller
        control={control}
        name="byWeekday"
        render={({ field }) => (
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Repeat on</legend>
            <div className="flex gap-1.5">
              {DAYS.map((d, i) => {
                const on = field.value.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    aria-pressed={on}
                    aria-label={DAY_NAMES[i]}
                    onClick={() => field.onChange(on ? field.value.filter((x) => x !== i) : [...field.value, i].sort())}
                    className={cn("size-9 rounded-full border text-sm font-medium", on ? "border-personal bg-personal text-white" : "border-border text-muted hover:bg-surface-muted")}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            {errors.byWeekday?.message && <p role="alert" className="mt-1 text-xs text-danger">{errors.byWeekday.message}</p>}
          </fieldset>
        )}
      />
      <Field label="Times per day" error={errors.targetPerDay?.message} hint="For example 8 for glasses of water.">
        {(p) => <Input type="number" min={1} max={100} className="w-24" {...p} {...register("targetPerDay", { valueAsNumber: true })} />}
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="personal" loading={isSubmitting}>{habit ? "Save" : "Add habit"}</Button>
      </div>
    </form>
  );
}

function HabitCard({ habit, onEdit, onDelete }: { habit: Habit; onEdit: () => void; onDelete: () => void }) {
  const [busy, setBusy] = useState(false);
  const done = habit.todayCount >= habit.targetPerDay;
  const today = habit.history[habit.history.length - 1]!.date;

  async function setCount(date: string, count: number) {
    setBusy(true);
    try {
      await api(`/api/habits/${habit.id}/log`, { method: "PUT", body: { date, count } });
      invalidate("/api/workspaces");
      invalidate("/api/analytics");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <button
          type="button"
          disabled={busy || !habit.dueToday}
          aria-pressed={done}
          aria-label={done ? `Undo ${habit.name} for today` : `Mark ${habit.name} done today`}
          onClick={() => setCount(today, habit.targetPerDay === 1 ? (done ? 0 : 1) : Math.min(100, habit.todayCount + 1))}
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-full border-2 transition-colors disabled:opacity-40",
            done ? "border-personal bg-personal text-white" : "border-border hover:border-personal",
          )}
        >
          {done ? <Check className="size-5" /> : habit.targetPerDay > 1 ? <span className="text-xs font-semibold">{habit.todayCount}/{habit.targetPerDay}</span> : null}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{habit.name}</p>
          <p className="text-xs text-muted">
            {habit.dueToday ? (done ? "Done for today" : "Today") : "Rest day"} · {habit.byWeekday.length === 7 ? "every day" : habit.byWeekday.map((d) => DAY_NAMES[d]!.slice(0, 3)).join(", ")}
          </p>
        </div>
        <div className="flex items-center gap-1 text-sm" title={`Longest streak: ${habit.longestStreak}`}>
          <Flame className={cn("size-4", habit.currentStreak ? "text-warning" : "text-muted")} aria-hidden />
          <span className="font-semibold tabular-nums">{habit.currentStreak}</span>
          <span className="sr-only">day streak</span>
        </div>
        <Button variant="ghost" size="icon" aria-label={`Edit ${habit.name}`} onClick={onEdit}><Pencil /></Button>
        <Button variant="ghost" size="icon" aria-label={`Delete ${habit.name}`} onClick={onDelete}><Trash2 /></Button>
      </div>
      <ol className="mt-3 flex justify-between gap-1" aria-label="Last 14 days">
        {habit.history.map((h) => (
          <li key={h.date} className="flex-1">
            <button
              type="button"
              disabled={busy || !h.due}
              title={`${h.date}${h.done ? " · done" : ""}`}
              aria-label={`${h.date}: ${h.done ? "done, click to undo" : h.due ? "not done, click to mark done" : "not scheduled"}`}
              onClick={() => setCount(h.date, h.done ? 0 : habit.targetPerDay)}
              className={cn(
                "h-6 w-full rounded-md",
                h.done ? "bg-personal" : h.due ? "bg-surface-muted hover:bg-border" : "bg-transparent ring-1 ring-inset ring-border",
                h.date === today && !h.done && "ring-2 ring-inset ring-personal/50",
              )}
            />
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default function View() {
  const { id } = useParams<{ id: string }>();
  const workspace = useWorkspace(id);
  const { data, error, reload } = useQuery<Habit[]>(workspace ? `/api/workspaces/${id}/habits` : null);
  const [editing, setEditing] = useState<Habit | "new" | null>(null);
  const [deleting, setDeleting] = useState<Habit | null>(null);

  if (!workspace) return <EmptyState title="Workspace not found" description="It may have been deleted, or you are no longer a member." />;
  const doneToday = data?.filter((h) => h.dueToday && h.todayCount >= h.targetPerDay).length ?? 0;
  const dueToday = data?.filter((h) => h.dueToday).length ?? 0;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Habits</h1>
          <p className="text-sm text-muted">
            {data && dueToday ? `${doneToday} of ${dueToday} done today. ` : ""}Habits are private to you, even in an organization.
          </p>
        </div>
        <Button variant="personal" onClick={() => setEditing("new")}><Plus /> New habit</Button>
      </div>

      {error ? (
        <Card><ErrorState message={error.message} onRetry={reload} /></Card>
      ) : !data ? (
        <div className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
      ) : data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Repeat />}
            title="No habits yet"
            description="Pick one small thing you want to do regularly. Missing a day is fine; streaks skip days a habit does not apply to."
            action={<Button variant="personal" onClick={() => setEditing("new")}><Plus /> Add your first habit</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {data.map((h) => (
            <HabitCard key={h.id} habit={h} onEdit={() => setEditing(h)} onDelete={() => setDeleting(h)} />
          ))}
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent title={editing === "new" ? "New habit" : "Edit habit"}>
          {editing && <HabitForm workspaceId={id} habit={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this habit?"
        description={`"${deleting?.name}" and its history will be removed. This can't be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          try {
            await api(`/api/habits/${deleting!.id}`, { method: "DELETE" });
            invalidate("/api/workspaces");
            invalidate("/api/analytics");
            toast.success("Habit deleted");
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not delete");
            throw e;
          }
        }}
      />
    </div>
  );
}
