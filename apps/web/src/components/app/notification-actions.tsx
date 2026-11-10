"use client";

import type { NotificationItem } from "@lifesync/shared";
import { AlarmClock, Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { invalidate } from "@/lib/use-query";

/** Snooze or finish the task a reminder is about, right from the notification. */
export function NotificationActions({ n }: { n: NotificationItem }) {
  const [busy, setBusy] = useState(false);
  if (!n.taskId || (n.type !== "reminder" && n.type !== "missed")) return null;

  const run = async (path: string, body: object, done: string) => {
    setBusy(true);
    try {
      await api(`/api/notifications/${n.id}/${path}`, { body });
      invalidate("/api/notifications");
      invalidate("/api/me");
      invalidate("/api/tasks");
      toast.success(done);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5 flex gap-2">
      <button
        disabled={busy}
        onClick={() => run("snooze", { minutes: 10 }, "Snoozed for 10 minutes")}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-muted disabled:opacity-50"
      >
        <AlarmClock className="size-3" aria-hidden /> Snooze 10 min
      </button>
      <button
        disabled={busy}
        onClick={() => run("complete", {}, "Task completed")}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-muted disabled:opacity-50"
      >
        <Check className="size-3" aria-hidden /> Mark done
      </button>
    </div>
  );
}
