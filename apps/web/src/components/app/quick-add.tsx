"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { PRIORITY_LABELS, TASK_PRIORITIES, LIMITS, localDate } from "@lifesync/shared";
import { useParams } from "next/navigation";
import { createContext, useContext, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { api, applyFormError } from "@/lib/api";
import { invalidate } from "@/lib/use-query";
import { useSession } from "./session";

const QuickAddContext = createContext<() => void>(() => {});
export const useQuickAdd = () => useContext(QuickAddContext);

const formSchema = z
  .object({
    workspaceId: z.string().min(1, { error: "Choose a workspace" }),
    title: z.string().trim().min(1, { error: "Give the task a title" }).max(LIMITS.taskTitleMax),
    priority: z.enum(TASK_PRIORITIES),
    dueDate: z.string(),
    dueTime: z.string(),
    estimate: z.string().regex(/^\d*$/, { error: "Use whole minutes" }),
  })
  .refine((v) => !v.dueTime || v.dueDate, { error: "Pick a date for this time", path: ["dueTime"] });
type Values = z.infer<typeof formSchema>;

/** Mounted fresh each time the dialog opens, so it never carries over the previous task's values. */
function QuickAddForm({ onDone }: { onDone: () => void }) {
  const { workspaces, profile } = useSession();
  const params = useParams<{ id?: string }>();
  const [formError, setFormError] = useState<string | null>(null);
  const [defaults] = useState<Values>(() => ({
    workspaceId:
      workspaces.find((w) => w.id === params.id)?.id ?? workspaces.find((w) => w.type === "personal")?.id ?? "",
    title: "",
    priority: "medium",
    dueDate: localDate(Date.now(), profile.timezone),
    dueTime: "",
    estimate: "",
  }));

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(formSchema), defaultValues: defaults });

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={handleSubmit(async (v) => {
        setFormError(null);
        try {
          await api("/api/tasks", {
            body: {
              workspaceId: v.workspaceId,
              title: v.title,
              priority: v.priority,
              dueDate: v.dueDate || null,
              dueTime: v.dueTime || null,
              estimatedMinutes: v.estimate ? Number(v.estimate) : null,
            },
          });
          invalidate("/api/dashboard");
          invalidate("/api/tasks");
          toast.success("Task added");
          onDone();
        } catch (e) {
          setFormError(applyFormError(e, setError));
        }
      })}
    >
      <FormError message={formError} />
      <Field label="Title" error={errors.title?.message}>
        {(p) => <Input autoFocus placeholder="What needs doing?" {...p} {...register("title")} />}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Workspace" error={errors.workspaceId?.message}>
          {(p) => (
            <Select {...p} {...register("workspaceId")}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.type === "personal" ? "Personal" : w.name}
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
        <Field label="Due date" error={errors.dueDate?.message}>
          {(p) => <Input type="date" {...p} {...register("dueDate")} />}
        </Field>
        <Field label="Due time" error={errors.dueTime?.message}>
          {(p) => <Input type="time" {...p} {...register("dueTime")} />}
        </Field>
      </div>
      <Field label="Estimate (minutes, optional)" error={errors.estimate?.message}>
        {(p) => <Input inputMode="numeric" placeholder="30" {...p} {...register("estimate")} />}
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={isSubmitting}>
          Add task
        </Button>
      </div>
    </form>
  );
}

function QuickAddDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Quick add task" description="Capture it now, add details later.">
        <QuickAddForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

export function QuickAddProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <QuickAddContext.Provider value={() => setOpen(true)}>
      {children}
      <QuickAddDialog open={open} onOpenChange={setOpen} />
    </QuickAddContext.Provider>
  );
}
