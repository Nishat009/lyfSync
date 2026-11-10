"use client";

import type { Me, WorkspaceSummary } from "@lifesync/shared";
import { createContext, useContext } from "react";

export const SessionContext = createContext<Me | null>(null);

export function useSession(): Me {
  const me = useContext(SessionContext);
  if (!me) throw new Error("useSession must be used inside the app layout");
  return me;
}

export function useWorkspace(id: string): WorkspaceSummary | undefined {
  return useSession().workspaces.find((w) => w.id === id);
}

export function usePersonalWorkspace(): WorkspaceSummary {
  const w = useSession().workspaces.find((x) => x.type === "personal");
  if (!w) throw new Error("Personal workspace missing");
  return w;
}

export function canManage(role: WorkspaceSummary["role"]) {
  return role === "admin" || role === "manager";
}
