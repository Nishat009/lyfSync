"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  categorySchema,
  projectSchema,
  type Category,
  type CategoryInput,
  type Project,
  type WorkspaceDetail,
} from "@lifesync/shared";
import { FolderKanban, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { canManage, useWorkspace } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, EmptyState, ErrorState, Skeleton } from "@/components/ui/card";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { api, applyFormError } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/use-query";
import { formatDay } from "@/lib/utils";
import { z } from "zod";

const COLORS = ["#2563eb", "#16a34a", "#7c3aed", "#d97706", "#0d9488", "#dc2626", "#64748b"];

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-2">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className="size-7 rounded-full ring-offset-2 ring-offset-surface"
          style={{ background: c, boxShadow: value === c ? `0 0 0 2px var(--surface), 0 0 0 4px ${c}` : undefined }}
        />
      ))}
    </div>
  );
}

const projectFormSchema = projectSchema.extend({
  description: z.string().max(2000),
  dueDate: z.string(),
});
type ProjectValues = z.infer<typeof projectFormSchema>;

function ProjectForm({ workspaceId, project, onDone }: { workspaceId: string; project?: Project; onDone: () => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    control,
    formState: { errors, isSubmitting },
  } = useForm<ProjectValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: {
      name: project?.name ?? "",
      description: project?.description ?? "",
      status: project?.status ?? "active",
      color: project?.color ?? COLORS[0],
      dueDate: project?.dueDate ?? "",
    },
  });
  const color = useWatch({ control, name: "color" });

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={handleSubmit(async (v) => {
        setFormError(null);
        const body = { ...v, description: v.description.trim() || null, dueDate: v.dueDate || null };
        try {
          if (project) await api(`/api/projects/${project.id}`, { method: "PATCH", body });
          else await api(`/api/workspaces/${workspaceId}/projects`, { body });
          invalidate(`/api/workspaces/${workspaceId}`);
          invalidate("/api/tasks");
          toast.success(project ? "Project saved" : "Project created");
          onDone();
        } catch (e) {
          setFormError(applyFormError(e, setError));
        }
      })}
    >
      <FormError message={formError} />
      <Field label="Name" error={errors.name?.message}>
        {(p) => <Input autoFocus {...p} {...register("name")} />}
      </Field>
      <Field label="Description" error={errors.description?.message}>
        {(p) => <Textarea {...p} {...register("description")} />}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Status">
          {(p) => (
            <Select {...p} {...register("status")}>
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PROJECT_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Due date" error={errors.dueDate?.message}>
          {(p) => <Input type="date" {...p} {...register("dueDate")} />}
        </Field>
      </div>
      <ColorPicker value={color} onChange={(c) => setValue("color", c)} />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={isSubmitting}>
          {project ? "Save" : "Create project"}
        </Button>
      </div>
    </form>
  );
}

function CategoryForm({ workspaceId, category, onDone }: { workspaceId: string; category?: Category; onDone: () => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    control,
    formState: { errors, isSubmitting },
  } = useForm<CategoryInput>({
    resolver: zodResolver(categorySchema),
    defaultValues: { name: category?.name ?? "", color: category?.color ?? COLORS[1] },
  });
  const color = useWatch({ control, name: "color" });
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={handleSubmit(async (v) => {
        setFormError(null);
        try {
          if (category) await api(`/api/categories/${category.id}`, { method: "PATCH", body: v });
          else await api(`/api/workspaces/${workspaceId}/categories`, { body: v });
          invalidate(`/api/workspaces/${workspaceId}`);
          invalidate("/api/tasks");
          toast.success(category ? "Category saved" : "Category added");
          onDone();
        } catch (e) {
          setFormError(applyFormError(e, setError));
        }
      })}
    >
      <FormError message={formError} />
      <Field label="Name" error={errors.name?.message}>
        {(p) => <Input autoFocus {...p} {...register("name")} />}
      </Field>
      <ColorPicker value={color} onChange={(c) => setValue("color", c)} />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={isSubmitting}>
          {category ? "Save" : "Add category"}
        </Button>
      </div>
    </form>
  );
}

type Editing = { kind: "project"; item?: Project } | { kind: "category"; item?: Category } | null;
type Deleting = { kind: "project"; item: Project } | { kind: "category"; item: Category } | null;

export default function ProjectsView() {
  const { id } = useParams<{ id: string }>();
  const workspace = useWorkspace(id);
  const projects = useQuery<Project[]>(workspace ? `/api/workspaces/${id}/projects` : null);
  const detail = useQuery<WorkspaceDetail>(workspace ? `/api/workspaces/${id}` : null);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Deleting>(null);

  if (!workspace) {
    return (
      <Card>
        <EmptyState title="Workspace not found" />
      </Card>
    );
  }
  const manage = canManage(workspace.role);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted">{workspace.type === "personal" ? "Personal" : workspace.name}</p>
        </div>
        {manage && (
          <Button onClick={() => setEditing({ kind: "project" })}>
            <Plus /> New project
          </Button>
        )}
      </div>

      {projects.loading && !projects.data ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : projects.error ? (
        <Card>
          <ErrorState message={projects.error.message} onRetry={projects.reload} />
        </Card>
      ) : projects.data && projects.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FolderKanban />}
            title="No projects yet"
            description={manage ? "Group related tasks into a project to track progress." : "Admins and managers can create projects."}
            action={
              manage && (
                <Button size="sm" onClick={() => setEditing({ kind: "project" })}>
                  <Plus /> Create a project
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {projects.data?.map((p) => {
            const pct = p.taskTotal ? Math.round((p.taskDone / p.taskTotal) * 100) : 0;
            return (
              <Card key={p.id} className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2 font-semibold">
                      <span className="size-3 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
                      <span className="truncate">{p.name}</span>
                    </h2>
                    {p.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{p.description}</p>}
                  </div>
                  <Badge tone={p.status === "active" ? "personal" : p.status === "on_hold" ? "warning" : "neutral"}>
                    {PROJECT_STATUS_LABELS[p.status]}
                  </Badge>
                </div>
                <div className="mt-4">
                  <div className="mb-1.5 flex justify-between text-xs text-muted">
                    <span>
                      {p.taskDone} of {p.taskTotal} tasks done
                    </span>
                    <span>{pct}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${p.name} progress`}>
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: p.color }} />
                  </div>
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-xs text-muted">{p.dueDate ? `Due ${formatDay(p.dueDate)}` : "No due date"}</span>
                  <div className="flex items-center gap-1">
                    <Link href={`/w/${id}/tasks?projectId=${p.id}`} className="rounded-lg px-2 py-1 text-sm font-medium text-work hover:bg-work-soft">
                      View tasks
                    </Link>
                    {manage && (
                      <>
                        <Button size="icon" variant="ghost" aria-label={`Edit ${p.name}`} onClick={() => setEditing({ kind: "project", item: p })}>
                          <Pencil />
                        </Button>
                        <Button size="icon" variant="ghost" aria-label={`Delete ${p.name}`} onClick={() => setDeleting({ kind: "project", item: p })}>
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader
          title="Categories"
          description="Label tasks by area of life or work."
          action={
            manage && (
              <Button size="sm" variant="outline" onClick={() => setEditing({ kind: "category" })}>
                <Plus /> Add category
              </Button>
            )
          }
        />
        <ul className="flex flex-wrap gap-2 px-5 pb-5">
          {detail.data?.categories.map((c) => (
            <li key={c.id} className="flex items-center gap-1 rounded-full border border-border py-1 pl-3 pr-1 text-sm">
              <span className="size-2.5 rounded-full" style={{ background: c.color }} aria-hidden />
              {c.name}
              {manage && (
                <>
                  <button aria-label={`Edit ${c.name}`} onClick={() => setEditing({ kind: "category", item: c })} className="rounded-full p-1 text-muted hover:bg-surface-muted">
                    <Pencil className="size-3" />
                  </button>
                  <button aria-label={`Delete ${c.name}`} onClick={() => setDeleting({ kind: "category", item: c })} className="rounded-full p-1 text-muted hover:bg-danger-soft hover:text-danger">
                    <Trash2 className="size-3" />
                  </button>
                </>
              )}
            </li>
          ))}
          {detail.data && detail.data.categories.length === 0 && <li className="text-sm text-muted">No categories yet.</li>}
        </ul>
      </Card>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent
          title={editing?.kind === "project" ? (editing.item ? "Edit project" : "New project") : editing?.item ? "Edit category" : "New category"}
        >
          {editing?.kind === "project" && <ProjectForm workspaceId={id} project={editing.item} onDone={() => setEditing(null)} />}
          {editing?.kind === "category" && <CategoryForm workspaceId={id} category={editing.item} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting?.kind === "project" ? "Delete this project?" : "Delete this category?"}
        description={
          deleting?.kind === "project"
            ? `"${deleting.item.name}" will be removed. Its tasks are kept and simply lose the project.`
            : `"${deleting?.item.name}" will be removed. Tasks that used it are kept without a category.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          const d = deleting!;
          try {
            await api(`/api/${d.kind === "project" ? "projects" : "categories"}/${d.item.id}`, { method: "DELETE" });
            invalidate(`/api/workspaces/${id}`);
            invalidate("/api/tasks");
            toast.success(d.kind === "project" ? "Project deleted" : "Category deleted");
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not delete");
            throw e;
          }
        }}
      />
    </div>
  );
}
