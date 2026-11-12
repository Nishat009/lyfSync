"use client";

import { BarChart3, Bell, CalendarDays, CheckSquare, FolderKanban, LayoutDashboard, Mail, NotebookPen, Repeat, Settings, Sun, Target, Users, UsersRound } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { Logo } from "./auth-shell";
import { canManage, useSession } from "./session";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { cn } from "@/lib/utils";

function NavLink({
  href,
  icon: Icon,
  label,
  collapsed,
  badge,
  exact,
  onNavigate,
}: {
  href: string;
  icon: typeof Sun;
  label: string;
  collapsed?: boolean;
  badge?: number;
  exact?: boolean;
  onNavigate?: () => void;
}) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-muted hover:text-foreground",
        active && "bg-surface-muted text-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="flex-1">{label}</span>}
      {!collapsed && !!badge && (
        <span className="rounded-full bg-work px-1.5 text-xs text-white" aria-label={`${badge} new`}>
          {badge}
        </span>
      )}
    </Link>
  );
}

export function Sidebar({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { workspaces, unreadNotifications, pendingInvitations } = useSession();
  const { id } = useParams<{ id?: string }>();
  const current = workspaces.find((w) => w.id === id);
  const nav = { collapsed, onNavigate };

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className={cn("px-1 pt-1", collapsed && "flex justify-center")}>
        {collapsed ? (
          <Link href="/" aria-label="LifeSync home" className="grid size-8 place-items-center rounded-lg bg-foreground text-white">
            L
          </Link>
        ) : (
          <Logo />
        )}
      </div>
      <WorkspaceSwitcher collapsed={collapsed} onNavigate={onNavigate} />
      <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
        <NavLink href="/my-day" icon={Sun} label="My Day" exact {...nav} />
        <NavLink href="/calendar" icon={CalendarDays} label="Calendar" exact {...nav} />
        <NavLink href="/focus" icon={Target} label="Focus" exact {...nav} />
        <NavLink href="/analytics" icon={BarChart3} label="Balance" exact {...nav} />
        {current && (
          <>
            {!collapsed && (
              <p className="mt-3 truncate px-3 text-xs font-semibold uppercase tracking-wide text-muted">{current.name}</p>
            )}
            <NavLink href={`/w/${current.id}`} icon={LayoutDashboard} label="Dashboard" exact {...nav} />
            <NavLink href={`/w/${current.id}/tasks`} icon={CheckSquare} label="Tasks" {...nav} />
            <NavLink href={`/w/${current.id}/calendar`} icon={CalendarDays} label="Workspace calendar" {...nav} />
            <NavLink href={`/w/${current.id}/projects`} icon={FolderKanban} label="Projects" {...nav} />
            <NavLink href={`/w/${current.id}/habits`} icon={Repeat} label="Habits" {...nav} />
            <NavLink href={`/w/${current.id}/notes`} icon={NotebookPen} label="Notes" {...nav} />
            {current.type === "organization" && canManage(current.role) && (
              <NavLink href={`/w/${current.id}/team`} icon={UsersRound} label="Team" {...nav} />
            )}
            {current.type === "organization" && (
              <NavLink href={`/w/${current.id}/members`} icon={Users} label="Members" {...nav} />
            )}
          </>
        )}
      </nav>
      <nav aria-label="Account" className="flex flex-col gap-1 border-t border-border pt-3">
        <NavLink href="/notifications" icon={Bell} label="Notifications" badge={unreadNotifications} {...nav} />
        <NavLink href="/invitations" icon={Mail} label="Invitations" badge={pendingInvitations} {...nav} />
        <NavLink href="/settings" icon={Settings} label="Settings" {...nav} />
      </nav>
    </div>
  );
}
