"use client";

import type { NotificationPage } from "@lifesync/shared";
import { Bell, CheckCheck, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, Skeleton } from "@/components/ui/card";
import { api } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/use-query";
import { cn, timeAgo } from "@/lib/utils";
import { NotificationActions } from "@/components/app/notification-actions";

export default function NotificationsPage() {
  const router = useRouter();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const key = `/api/notifications?limit=50${unreadOnly ? "&unread=true" : ""}`;
  const { data, error, loading, reload } = useQuery<NotificationPage>(key);

  const refresh = () => {
    invalidate("/api/notifications");
    invalidate("/api/me");
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-muted">Reminders, invitations and updates.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setUnreadOnly((v) => !v)} aria-pressed={unreadOnly}>
            {unreadOnly ? "Showing unread" : "Show unread only"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              await api("/api/notifications/read-all", { body: {} });
              refresh();
            }}
          >
            <CheckCheck /> Mark all read
          </Button>
        </div>
      </div>

      <Card>
        {loading && !data ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : error ? (
          <ErrorState message={error.message} onRetry={reload} />
        ) : data && data.items.length === 0 ? (
          <EmptyState
            icon={<Bell />}
            title={unreadOnly ? "Nothing unread" : "No notifications yet"}
            description="Task reminders and organization invitations will appear here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {data?.items.map((n) => (
              <li key={n.id} className={cn("flex items-start gap-3 px-5 py-3", !n.readAt && "bg-work-soft/40")}>
                <div className="min-w-0 flex-1">
                <button
                  className="block w-full text-left"
                  onClick={async () => {
                    if (!n.readAt) {
                      await api(`/api/notifications/${n.id}/read`, { body: {} });
                      refresh();
                    }
                    if (n.link?.startsWith("/")) router.push(n.link);
                  }}
                >
                  <span className="block text-sm font-medium">{n.title}</span>
                  {n.body && <span className="block text-sm text-muted">{n.body}</span>}
                  <span className="mt-0.5 block text-xs text-muted">{timeAgo(n.createdAt)}</span>
                </button>
                <NotificationActions n={n} />
                </div>
                <button
                  aria-label={`Delete notification: ${n.title}`}
                  className="rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
                  onClick={async () => {
                    try {
                      await api(`/api/notifications/${n.id}`, { method: "DELETE" });
                      refresh();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Could not delete");
                    }
                  }}
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
