"use client";

import { ROLE_LABELS, type MyInvitation } from "@lifesync/shared";
import { Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, Skeleton } from "@/components/ui/card";
import { api } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/use-query";
import { formatDay } from "@/lib/utils";

export default function InvitationsPage() {
  const router = useRouter();
  const { data, error, loading, reload } = useQuery<MyInvitation[]>("/api/invitations/mine");

  const respond = async (i: MyInvitation, accept: boolean) => {
    try {
      const res = await api<{ workspaceId?: string }>(`/api/invitations/${accept ? "accept" : "decline"}`, {
        body: { invitationId: i.id },
      });
      invalidate("/api/invitations");
      invalidate("/api/me");
      toast.success(accept ? `You joined ${i.workspaceName}` : "Invitation declined");
      if (accept && res.workspaceId) router.push(`/w/${res.workspaceId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
      invalidate("/api/invitations");
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Invitations</h1>
        <p className="mt-1 text-sm text-muted">Organizations that invited your email address.</p>
      </div>
      <Card>
        {loading && !data ? (
          <Skeleton className="m-5 h-12" />
        ) : error ? (
          <ErrorState message={error.message} onRetry={reload} />
        ) : data && data.length === 0 ? (
          <EmptyState icon={<Mail />} title="No pending invitations" description="When someone invites you to an organization it will show up here." />
        ) : (
          <ul className="divide-y divide-border">
            {data?.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{i.workspaceName}</p>
                  <p className="text-xs text-muted">
                    {i.invitedByName ?? "A teammate"} invited you as {ROLE_LABELS[i.role].toLowerCase()} · expires{" "}
                    {formatDay(i.expiresAt.slice(0, 10))}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => respond(i, false)}>
                  Decline
                </Button>
                <Button variant="work" size="sm" onClick={() => respond(i, true)}>
                  Accept
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
