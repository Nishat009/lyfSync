"use client";

import { NOTE_KINDS, NOTE_KIND_LABELS, noteSchema, type Note, type NoteKind } from "@lifesync/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { ListPlus, Lock, NotebookPen, Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useWorkspace } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, ErrorState, Skeleton } from "@/components/ui/card";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { api, ApiError, applyFormError } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/use-query";
import { timeAgo } from "@/lib/utils";

const formSchema = z.object({
  title: z.string().max(200),
  body: z.string().max(50000),
  kind: z.enum(NOTE_KINDS),
  visibility: z.enum(["private", "workspace"]),
});
type Values = z.infer<typeof formSchema>;

function NoteForm({ workspaceId, isOrg, note, onDone }: { workspaceId: string; isOrg: boolean; note?: Note; onDone: () => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: note?.title ?? "",
      body: note?.body ?? "",
      kind: note?.kind ?? (isOrg ? "meeting" : "quick"),
      visibility: note?.visibility ?? "private",
    },
  });
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={handleSubmit(async (v) => {
        setFormError(null);
        const parsed = noteSchema.safeParse({ ...v, title: v.title.trim() || null });
        if (!parsed.success) {
          setError("body", { message: parsed.error.issues[0]?.message ?? "Write something first" });
          return;
        }
        try {
          if (note) await api(`/api/notes/${note.id}`, { method: "PATCH", body: parsed.data });
          else await api(`/api/workspaces/${workspaceId}/notes`, { body: parsed.data });
          invalidate("/api/workspaces");
          toast.success(note ? "Note saved" : "Note added");
          onDone();
        } catch (e) {
          setFormError(applyFormError(e, setError));
        }
      })}
    >
      <FormError message={formError} />
      <Field label="Title (optional)" error={errors.title?.message}>
        {(p) => <Input {...p} {...register("title")} />}
      </Field>
      <Field label="Note" error={errors.body?.message}>
        {(p) => <Textarea autoFocus rows={8} {...p} {...register("body")} />}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          {(p) => (
            <Select {...p} {...register("kind")}>
              {NOTE_KINDS.map((k) => (
                <option key={k} value={k}>{NOTE_KIND_LABELS[k]}</option>
              ))}
            </Select>
          )}
        </Field>
        {isOrg && (
          <Field label="Who can see it">
            {(p) => (
              <Select {...p} {...register("visibility")}>
                <option value="private">Only me</option>
                <option value="workspace">Everyone in the workspace</option>
              </Select>
            )}
          </Field>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" loading={isSubmitting}>{note ? "Save" : "Add note"}</Button>
      </div>
    </form>
  );
}

export default function View() {
  const { id } = useParams<{ id: string }>();
  const workspace = useWorkspace(id);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<NoteKind | "">("");
  const [editing, setEditing] = useState<Note | "new" | null>(null);
  const [deleting, setDeleting] = useState<Note | null>(null);
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (kind) params.set("kind", kind);
  const { data, error, reload } = useQuery<Note[]>(workspace ? `/api/workspaces/${id}/notes?${params}` : null);

  if (!workspace) return <EmptyState title="Workspace not found" description="It may have been deleted, or you are no longer a member." />;
  const isOrg = workspace.type === "organization";

  async function toTask(n: Note) {
    try {
      await api(`/api/notes/${n.id}/convert`, { method: "POST" });
      invalidate("/api/workspaces");
      invalidate("/api/tasks");
      toast.success("Task created from your note");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not create the task");
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Notes</h1>
          <p className="text-sm text-muted">{isOrg ? "Private notes stay yours; share meeting notes with the workspace when useful." : "Only you can see these."}</p>
        </div>
        <Button onClick={() => setEditing("new")}><Plus /> New note</Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input aria-label="Search notes" placeholder="Search notes" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select aria-label="Filter by type" className="w-44" value={kind} onChange={(e) => setKind(e.target.value as NoteKind | "")}>
          <option value="">All types</option>
          {NOTE_KINDS.map((k) => (
            <option key={k} value={k}>{NOTE_KIND_LABELS[k]}</option>
          ))}
        </Select>
      </div>

      {error ? (
        <Card><ErrorState message={error.message} onRetry={reload} /></Card>
      ) : !data ? (
        <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
      ) : data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<NotebookPen />}
            title={q || kind ? "No notes match" : "No notes yet"}
            description={q || kind ? "Try a different search or type." : "Capture a thought, meeting minutes or an idea. You can turn any note into a task later."}
            action={!q && !kind ? <Button onClick={() => setEditing("new")}><Plus /> Write a note</Button> : undefined}
          />
        </Card>
      ) : (
        <ul className="space-y-3">
          {data.map((n) => (
            <li key={n.id}>
              <Card className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{n.title || n.body.split("\n")[0] || "Untitled"}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      <Badge>{NOTE_KIND_LABELS[n.kind]}</Badge>
                      {n.visibility === "workspace" ? (
                        <span className="inline-flex items-center gap-1"><Users className="size-3" aria-hidden /> Shared</span>
                      ) : (
                        <span className="inline-flex items-center gap-1"><Lock className="size-3" aria-hidden /> Private</span>
                      )}
                      {!n.mine && <span>by {n.authorName}</span>}
                      <span>· {timeAgo(n.updatedAt)}</span>
                      {n.taskId && (
                        <Link href={`/w/${n.workspaceId}/tasks`} className="underline-offset-2 hover:underline">
                          · Task: {n.taskTitle ?? "linked task"}
                        </Link>
                      )}
                    </div>
                  </div>
                  {n.mine && (
                    <div className="flex shrink-0 gap-1">
                      {!n.taskId && (
                        <Button variant="ghost" size="icon" aria-label="Convert to task" title="Convert to task" onClick={() => toTask(n)}><ListPlus /></Button>
                      )}
                      <Button variant="ghost" size="icon" aria-label="Edit note" onClick={() => setEditing(n)}><Pencil /></Button>
                      <Button variant="ghost" size="icon" aria-label="Delete note" onClick={() => setDeleting(n)}><Trash2 /></Button>
                    </div>
                  )}
                </div>
                {n.body && <p className="mt-2 line-clamp-6 whitespace-pre-wrap text-sm">{n.body}</p>}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent title={editing === "new" ? "New note" : "Edit note"}>
          {editing && <NoteForm workspaceId={id} isOrg={isOrg} note={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this note?"
        description="This can't be undone. A task created from it is kept."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          try {
            await api(`/api/notes/${deleting!.id}`, { method: "DELETE" });
            invalidate("/api/workspaces");
            toast.success("Note deleted");
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : "Could not delete the note");
            throw e;
          }
        }}
      />
    </div>
  );
}
