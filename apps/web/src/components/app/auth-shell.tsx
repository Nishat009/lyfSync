"use client";

import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Card } from "@/components/ui/card";
import { useQuery } from "@/lib/use-query";
import type { Me } from "@lifesync/shared";

export function Logo() {
  return (
    <Link href="/" className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight">
      <span className="grid size-8 place-items-center rounded-lg bg-foreground text-white">
        <CheckCircle2 className="size-4" />
      </span>
      LifeSync
    </Link>
  );
}

/** Where to go after signing in: a same-site path from ?next=, otherwise My Day. */
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/my-day";
}

export function useRedirectIfSignedIn(next: string | null) {
  const router = useRouter();
  const { data } = useQuery<Me>("/api/me");
  useEffect(() => {
    if (data) router.replace(safeNext(next));
  }, [data, next, router]);
}

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Logo />
        </div>
        <Card className="p-6">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-5 space-y-4">{children}</div>
        </Card>
        {footer && <p className="text-center text-sm text-muted">{footer}</p>}
      </div>
    </main>
  );
}
