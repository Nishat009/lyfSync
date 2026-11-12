"use client";

import { STATUS_LABELS, localDate, localTime, type ActivityEntry, type TaskComment, type TaskDetail, type TaskStatus } from "@lifesync/shared";
import { ChevronDown, History, MessageSquare, Pencil, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input, Select, Textarea } from "@/components/ui/form";
import { api } from "@/lib/api";
import { describeAction } from "@/lib/activity";
import { invalidate, useQuery } from "@/lib/use-query";
import { formatDay, formatTime, timeAgo } from "@/lib/utils";
import { AssigneePicker } from "./assignees";
import { useSession } from "./session";

const fail = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

/** Choose who a task is assigned to. Shown to managers and admins. */
export function AssignEditor({ task, onClose }: { task: TaskDetail; onClose: () => void }) {
  const [ids, setIds] = useState(() => task.assignees.map((a) => a.userId));
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <AssigneePicker workspaceId={task.workspaceId} value={ids} onChange={setIds} />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">{ids.length === 0 ? "Nobody assigned" : `${ids.length} selected`}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="work"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/api/tasks/${task.id}/assignees`, { method: "PUT", body: { userIds: ids } });
                invalidate("/api/tasks");
                invalidate("/api/dashboard");
                invalidate("/api/workspaces");
                toast.success("Assignment updated");
                onClose();
              } catch (e) {
                fail(e, "Could not update the assignment");
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * What somebody who was only assigned a task can change: how far along it is, what they spent
 * and a progress note. Everything else about the task stays with its creator and the managers.
 */
export function ProgressUpdate({ task }: { task: TaskDetail }) {
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [minutes, setMinutes] = useState(String(task.actualMinutes));
  const [busy, setBusy] = useState(false);
  const dirty = status !== task.status || notes !== (task.notes ?? "") || minutes !== String(task.actualMinutes);
  return (
    <section aria-label="Your progress" className="space-y-3 rounded-lg border border-border p-3">
      <h3 className="text-sm font-semibold">Your progress</h3>
      <p className="text-xs text-muted">You were assigned this task, so you can update its status, time spent and notes.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted">Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)} aria-label="Status">
            {(["todo", "in_progress", "completed", "cancelled"] as const).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted">Minutes spent</span>
          <Input type="number" min={0} max={100000} value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Minutes spent" />
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block text-xs text-muted">Notes</span>
        <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Progress notes" />
      </label>
      <Button
        size="sm"
        variant="work"
        disabled={!dirty}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { status, notes: notes.trim() || null, actualMinutes: Number(minutes) || 0 } });
            invalidate("/api/tasks");
            invalidate("/api/dashboard");
            toast.success("Progress saved");
          } catch (e) {
            fail(e, "Could not save your progress");
          } finally {
            setBusy(false);
          }
        }}
      >
        Save progress
      </Button>
    </section>
  );
}

export function TaskComments({ taskId }: { taskId: string }) {
  const { data, error, reload } = useQuery<TaskComment[]>(`/api/tasks/${taskId}/comments`);
  const { profile } = useSession();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const base = `/api/tasks/${taskId}/comments`;

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      await api(base, { body: { body: text } });
      setText("");
      invalidate(base);
    } catch (e) {
      fail(e, "Could not post the comment");
    } finally {
      setSending(false);
    }
  };

  return (
    <section aria-label="Comments">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <MessageSquare className="size-3.5" aria-hidden /> Comments{data && data.length > 0 ? ` (${data.length})` : ""}
      </h3>
      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !data ? (
        <Skeleton className="h-16" />
      ) : (
        <ul className="space-y-3">
          {data.length === 0 && <li className="text-sm text-muted">No comments yet. Start the conversation below.</li>}
          {data.map((c) => (
            <li key={c.id} className="flex gap-2.5">
              <Avatar name={c.author?.fullName ?? "?"} src={c.author?.avatarUrl} className="mt-0.5 size-7 text-[10px]" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted">
                  <span className="font-medium text-foreground">{c.author?.fullName ?? "Former member"}</span> · {timeAgo(c.createdAt)}
                  {c.editedAt && " · edited"}
                </p>
                {editing?.id === c.id ? (
                  <form
                    className="mt-1 space-y-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        await api(`${base}/${c.id}`, { method: "PATCH", body: { body: editing.text } });
                        setEditing(null);
                        invalidate(base);
                      } catch (err) {
                        fail(err, "Could not save the comment");
                      }
                    }}
                  >
                    <Textarea rows={2} autoFocus aria-label="Edit comment" value={editing.text} onChange={(e) => setEditing({ id: c.id, text: e.target.value })} />
                    <div className="flex gap-2">
                      <Button size="sm" type="submit" disabled={!editing.text.trim()}>
                        Save
                      </Button>
                      <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <p className="whitespace-pre-wrap break-words text-sm">{c.body}</p>
                )}
                {editing?.id !== c.id && (c.canEdit || c.canDelete) && (
                  <div className="mt-0.5 flex gap-3 text-xs text-muted">
                    {c.canEdit && (
                      <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setEditing({ id: c.id, text: c.body })}>
                        <Pencil className="size-3" aria-hidden /> Edit
                      </button>
                    )}
                    {c.canDelete && (
                      <button className="inline-flex items-center gap-1 hover:text-danger" onClick={() => setRemoving(c.id)}>
                        <Trash2 className="size-3" aria-hidden /> Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Avatar name={profile.fullName} src={profile.avatarUrl} className="mt-1 size-7 text-[10px]" />
        <Textarea
          rows={2}
          placeholder="Write a comment…"
          aria-label="Write a comment"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button type="submit" size="sm" variant="work" loading={sending} disabled={!text.trim()} aria-label="Post comment">
          <Send /> Post
        </Button>
      </form>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Delete this comment?"
        description="This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          try {
            await api(`${base}/${removing}`, { method: "DELETE" });
            invalidate(base);
          } catch (e) {
            fail(e, "Could not delete the comment");
            throw e;
          }
        }}
      />
    </section>
  );
}

export function when(iso: string, timezone: string): string {
  const d = new Date(iso);
  return `${formatDay(localDate(d, timezone))}, ${formatTime(localTime(d, timezone))}`;
}

/** Who did what to this task. Loaded only once opened. */
export function TaskHistory({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const { profile } = useSession();
  const { data, error, reload } = useQuery<ActivityEntry[]>(open ? `/api/tasks/${taskId}/activity` : null);
  return (
    <section aria-label="History">
      <button
        className="flex w-full items-center gap-1.5 text-sm font-semibold"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <History className="size-3.5" aria-hidden /> History
        <ChevronDown className={`ml-auto size-4 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open &&
        (error ? (
          <ErrorState message={error.message} onRetry={reload} />
        ) : !data ? (
          <Skeleton className="mt-2 h-16" />
        ) : (
          <ol className="mt-2 space-y-1.5 border-l border-border pl-3">
            {data.map((e) => (
              <li key={e.id} className="text-sm">
                <span className="font-medium">{e.actor?.fullName ?? "Someone"}</span> {describeAction(e)}
                <span className="block text-xs text-muted">{when(e.createdAt, profile.timezone)}</span>
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}
