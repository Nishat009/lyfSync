"use client";

import type { NotificationPage } from "@lifesync/shared";
import { Bell, CheckCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Popover } from "radix-ui";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/card";
import { api } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/use-query";
import { cn, timeAgo } from "@/lib/utils";
import { useSession } from "./session";

export function NotificationCenter() {
  const { unreadNotifications } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { data, error, loading, reload } = useQuery<NotificationPage>(open ? "/api/notifications?limit=8" : null);

  const markAll = async () => {
    await api("/api/notifications/read-all", { method: "POST", body: {} });
    invalidate("/api/notifications");
    invalidate("/api/me");
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={unreadNotifications ? `Notifications, ${unreadNotifications} unread` : "Notifications"}
        className="relative grid size-9 place-items-center rounded-lg hover:bg-surface-muted"
      >
        <Bell className="size-4" />
        {unreadNotifications > 0 && (
          <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
            {unreadNotifications > 9 ? "9+" : unreadNotifications}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[min(24rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-surface shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            <button
              onClick={markAll}
              disabled={!unreadNotifications}
              className="flex items-center gap-1 text-xs text-muted hover:text-foreground disabled:opacity-40"
            >
              <CheckCheck className="size-3.5" /> Mark all read
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {loading && !data ? (
              <div className="space-y-3 p-4">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : error ? (
              <ErrorState message={error.message} onRetry={reload} />
            ) : data && data.items.length === 0 ? (
              <EmptyState icon={<Bell />} title="You're all caught up" description="Reminders and invitations will show up here." />
            ) : (
              <ul>
                {data?.items.map((n) => (
                  <li key={n.id}>
                    <button
                      className={cn(
                        "flex w-full gap-3 border-b border-border px-4 py-3 text-left last:border-0 hover:bg-surface-muted",
                        !n.readAt && "bg-work-soft/50",
                      )}
                      onClick={async () => {
                        setOpen(false);
                        if (!n.readAt) {
                          await api(`/api/notifications/${n.id}/read`, { method: "POST", body: {} });
                          invalidate("/api/notifications");
                          invalidate("/api/me");
                        }
                        if (n.link?.startsWith("/")) router.push(n.link);
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{n.title}</span>
                        {n.body && <span className="block truncate text-xs text-muted">{n.body}</span>}
                        <span className="mt-0.5 block text-xs text-muted">{timeAgo(n.createdAt)}</span>
                      </span>
                      {!n.readAt && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-work" aria-label="Unread" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="block border-t border-border px-4 py-2.5 text-center text-xs font-medium text-work"
          >
            View all
          </Link>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
