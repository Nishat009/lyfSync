"use client";

import { Briefcase, Check, ChevronsUpDown, Home, Layers, Plus } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { CreateOrgDialog } from "./create-org-dialog";
import { useSession } from "./session";

export function WorkspaceSwitcher({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { workspaces } = useSession();
  const params = useParams<{ id?: string }>();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const current = workspaces.find((w) => w.id === params.id);

  const go = (href: string) => {
    onNavigate?.();
    router.push(href);
  };

  const Icon = current ? (current.type === "personal" ? Home : Briefcase) : Layers;
  const tone = current ? (current.type === "personal" ? "text-personal bg-personal-soft" : "text-work bg-work-soft") : "bg-surface-muted";

  return (
    <>
      <Menu>
        <MenuTrigger
          aria-label="Switch workspace"
          className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-2 text-left hover:bg-surface-muted"
        >
          <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", tone)}>
            <Icon className="size-4" />
          </span>
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{current?.name ?? "My Day"}</span>
                <span className="block text-xs text-muted">
                  {current ? (current.type === "personal" ? "Personal" : "Organization") : "Everything together"}
                </span>
              </span>
              <ChevronsUpDown className="size-4 text-muted" />
            </>
          )}
        </MenuTrigger>
        <MenuContent align="start" className="w-64">
          <MenuItem onSelect={() => go("/my-day")}>
            <Layers /> My Day (combined)
            {!current && <Check className="ml-auto" />}
          </MenuItem>
          <MenuSeparator />
          <MenuLabel className="px-3 py-1 text-xs text-muted">Workspaces</MenuLabel>
          {workspaces.map((w) => (
            <MenuItem key={w.id} onSelect={() => go(`/w/${w.id}`)}>
              {w.type === "personal" ? <Home className="text-personal" /> : <Briefcase className="text-work" />}
              <span className="truncate">{w.name}</span>
              {w.id === params.id && <Check className="ml-auto" />}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => setCreating(true)}>
            <Plus /> Create organization
          </MenuItem>
        </MenuContent>
      </Menu>
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
