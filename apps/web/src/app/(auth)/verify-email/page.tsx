"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AuthShell } from "@/components/app/auth-shell";
import { api } from "@/lib/api";
import { invalidate } from "@/lib/use-query";

function Verify() {
  const token = useSearchParams().get("token");
  const [state, setState] = useState<"working" | "ok" | "failed">(token ? "working" : "failed");
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true; // a token is single-use, so never send it twice
    api("/api/auth/verify-email", { body: { token } })
      .then(() => {
        invalidate("/api/me");
        setState("ok");
      })
      .catch(() => setState("failed"));
  }, [token]);

  return (
    <AuthShell
      title={state === "ok" ? "Email confirmed" : state === "failed" ? "Link not valid" : "Confirming your email…"}
      subtitle={
        state === "failed"
          ? "This confirmation link is invalid or has expired. You can request a new one from inside the app."
          : undefined
      }
    >
      {state !== "working" && (
        <Link href="/my-day" className="text-sm font-medium underline underline-offset-2">
          Continue to LifeSync
        </Link>
      )}
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
