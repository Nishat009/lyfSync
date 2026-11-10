"use client";

import type { Me } from "@lifesync/shared";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AppShell } from "@/components/app/app-shell";
import { SessionContext } from "@/components/app/session";
import { ErrorState, Skeleton } from "@/components/ui/card";
import { invalidate, useQuery } from "@/lib/use-query";

export function AppGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: me, error, reload } = useQuery<Me>("/api/me");

  const signedOut = error?.status === 401;
  useEffect(() => {
    // Keep the query string so invitation links (?token=…) survive the sign-in detour.
    if (signedOut) router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }, [signedOut, router]);

  // Keeps the unread badge fresh without needing push yet.
  useEffect(() => {
    const t = setInterval(() => invalidate("/api/me"), 60_000);
    return () => clearInterval(t);
  }, []);

  if (me) {
    return (
      <SessionContext.Provider value={me}>
        <AppShell>{children}</AppShell>
      </SessionContext.Provider>
    );
  }
  if (error && !signedOut) {
    return (
      <div className="grid min-h-screen place-items-center">
        <ErrorState message={error.message} onRetry={reload} />
      </div>
    );
  }
  return (
    <div className="flex min-h-screen">
      <div className="hidden w-64 border-r border-border bg-surface p-3 lg:block">
        <Skeleton className="h-10" />
      </div>
      <div className="flex-1 space-y-4 p-6">
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}
