"use client";

import { useParams } from "next/navigation";
import { CalendarView } from "@/components/app/calendar-view";
import { useWorkspace } from "@/components/app/session";
import { Card, EmptyState } from "@/components/ui/card";

export default function WorkspaceCalendarPage() {
  const { id } = useParams<{ id: string }>();
  if (!useWorkspace(id)) {
    return (
      <Card>
        <EmptyState title="Workspace not found" />
      </Card>
    );
  }
  return <CalendarView key={id} workspaceId={id} />;
}
