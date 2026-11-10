"use client";

import { useParams } from "next/navigation";
import { DashboardView } from "@/components/app/dashboard-view";
import { useWorkspace } from "@/components/app/session";
import { Card, EmptyState } from "@/components/ui/card";

export default function WorkspaceDashboardPage() {
  const { id } = useParams<{ id: string }>();
  if (!useWorkspace(id)) {
    return (
      <Card>
        <EmptyState title="Workspace not found" description="It may have been deleted, or you may no longer be a member." />
      </Card>
    );
  }
  return <DashboardView key={id} workspaceId={id} />;
}
