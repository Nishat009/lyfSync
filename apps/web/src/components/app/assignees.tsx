"use client";

import { ROLE_LABELS, type Assignee, type Member } from "@lifesync/shared";
import { Avatar } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/card";
import { useQuery } from "@/lib/use-query";
import { cn } from "@/lib/utils";
import { useSession } from "./session";

/** Overlapping avatars of the people a task is assigned to. `decorative` hides the avatars from assistive tech when the names are already written next to them. */
export function AssigneeAvatars({ assignees, max = 3, className, decorative }: { assignees: Assignee[]; max?: number; className?: string; decorative?: boolean }) {
  if (!assignees.length) return null;
  const shown = assignees.slice(0, max);
  const extra = assignees.length - shown.length;
  return (
    <span
      className={cn("flex shrink-0 items-center -space-x-1.5", className)}
      title={`Assigned to ${assignees.map((a) => a.fullName).join(", ")}`}
      aria-hidden={decorative || undefined}
    >
      {shown.map((a) => (
        <Avatar key={a.userId} name={a.fullName} src={a.avatarUrl} className="size-6 border-2 border-surface text-[10px]" />
      ))}
      {extra > 0 && (
        <span className="grid size-6 place-items-center rounded-full border-2 border-surface bg-surface-muted text-[10px] font-medium text-muted">+{extra}</span>
      )}
      {!decorative && <span className="sr-only">Assigned to {assignees.map((a) => a.fullName).join(", ")}</span>}
    </span>
  );
}

/** Checklist of the workspace's members to choose assignees from. */
export function AssigneePicker({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const { user } = useSession();
  const { data, error } = useQuery<Member[]>(`/api/workspaces/${workspaceId}/members`);
  if (error) return <p className="text-sm text-danger">Could not load members: {error.message}</p>;
  if (!data) return <Skeleton className="h-24" />;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <ul className="max-h-44 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-surface" aria-label="People">
      {data.map((m) => (
        <li key={m.userId}>
          <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-muted">
            <input
              type="checkbox"
              className="size-4 accent-[var(--work)]"
              checked={value.includes(m.userId)}
              onChange={() => toggle(m.userId)}
              aria-label={`Assign to ${m.fullName}`}
            />
            <Avatar name={m.fullName} src={m.avatarUrl} className="size-6 text-[10px]" />
            <span className="min-w-0 flex-1 truncate text-sm">
              {m.fullName}
              {m.userId === user.id && <span className="text-muted"> (you)</span>}
            </span>
            <span className="text-xs text-muted">{ROLE_LABELS[m.role]}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}
