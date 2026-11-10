"use client";

import { ROLE_LABELS, type InvitationPreview } from "@lifesync/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, ErrorState, Skeleton } from "@/components/ui/card";
import { api } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/use-query";

/** Landing page for the link in an invitation email. Signed-out visitors are sent to /login and back. */
function Invite() {
  const router = useRouter();
  const token = useSearchParams().get("token");
  const [busy, setBusy] = useState(false);
  const { data, error, loading } = useQuery<InvitationPreview>(token ? `/api/invitations/preview?t=${token.slice(0, 8)}` : null, () =>
    api<InvitationPreview>("/api/invitations/preview", { body: { token } }),
  );

  const respond = async (accept: boolean) => {
    setBusy(true);
    try {
      const res = await api<{ workspaceId?: string }>(`/api/invitations/${accept ? "accept" : "decline"}`, { body: { token } });
      invalidate("/api/me");
      toast.success(accept ? `You joined ${data?.workspaceName}` : "Invitation declined");
      router.replace(accept && res.workspaceId ? `/w/${res.workspaceId}` : "/my-day");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md pt-10">
      <Card className="p-6">
        {!token ? (
          <ErrorState message="This invitation link is incomplete. Open it again from your email." />
        ) : loading ? (
          <Skeleton className="h-24" />
        ) : error ? (
          <div className="space-y-3 text-center">
            <p className="text-sm font-medium">This invitation isn&apos;t available</p>
            <p className="text-sm text-muted">
              It may have expired, or it was sent to a different email address than the one you&apos;re signed in with.
            </p>
            <Link href="/my-day" className="text-sm font-medium underline underline-offset-2">
              Go to My Day
            </Link>
          </div>
        ) : data ? (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-semibold">Join {data.workspaceName}</h1>
              <p className="mt-1 text-sm text-muted">
                {data.invitedByName ?? "A teammate"} invited you as {ROLE_LABELS[data.role].toLowerCase()}.
              </p>
            </div>
            {data.status === "pending" ? (
              <div className="flex gap-2">
                <Button variant="work" loading={busy} onClick={() => respond(true)}>
                  Accept invitation
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => respond(false)}>
                  Decline
                </Button>
              </div>
            ) : (
              <p className="rounded-lg bg-surface-muted px-3 py-2 text-sm">This invitation is {data.status}.</p>
            )}
            <p className="text-xs text-muted">Joining never gives the organization access to your personal workspace.</p>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

export default function InvitePage() {
  return (
    <Suspense>
      <Invite />
    </Suspense>
  );
}
