"use client";

import { LogOut, Menu as MenuIcon, PanelLeft, Plus, Search, Settings } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { invalidate } from "@/lib/use-query";
import { cn } from "@/lib/utils";
import { NotificationCenter } from "./notification-center";
import { QuickAddProvider, useQuickAdd } from "./quick-add";
import { TaskDialogsProvider } from "./task-dialogs";
import { useSession } from "./session";
import { Sidebar } from "./sidebar";

const COLLAPSE_KEY = "lifesync.sidebar.collapsed";

function VerifyBanner() {
  const { user } = useSession();
  const [busy, setBusy] = useState(false);
  if (user.emailVerified) return null;
  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-warning-soft px-4 py-2 text-sm text-warning">
      Confirm your email address to make sure you receive reminders and invitations.
      <button
        disabled={busy}
        className="font-medium underline underline-offset-2 disabled:opacity-60"
        onClick={async () => {
          setBusy(true);
          try {
            await api("/api/auth/resend-verification", { body: {} });
            toast.success("Confirmation email sent");
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not send the email");
          } finally {
            setBusy(false);
          }
        }}
      >
        Resend email
      </button>
    </div>
  );
}

function Topbar({ onMenu, onToggle }: { onMenu: () => void; onToggle: () => void }) {
  const { profile, workspaces } = useSession();
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const openQuickAdd = useQuickAdd();
  const [q, setQ] = useState("");

  const searchWorkspace = workspaces.find((w) => w.id === params.id) ?? workspaces.find((w) => w.type === "personal");

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/90 px-3 backdrop-blur sm:px-5">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenu} aria-label="Open menu">
        <MenuIcon />
      </Button>
      <Button variant="ghost" size="icon" className="hidden lg:inline-flex" onClick={onToggle} aria-label="Collapse or expand sidebar">
        <PanelLeft />
      </Button>
      <form
        role="search"
        className="relative hidden max-w-sm flex-1 sm:block"
        onSubmit={(e) => {
          e.preventDefault();
          if (searchWorkspace) router.push(`/w/${searchWorkspace.id}/tasks?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={`Search tasks in ${searchWorkspace?.type === "personal" ? "Personal" : (searchWorkspace?.name ?? "workspace")}`}
          placeholder={`Search tasks in ${searchWorkspace?.type === "personal" ? "Personal" : (searchWorkspace?.name ?? "")}…`}
          className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm"
        />
      </form>
      <div className="ml-auto flex items-center gap-1.5">
        <Button size="sm" onClick={openQuickAdd}>
          <Plus /> <span className="hidden sm:inline">Quick add</span>
          <span className="sr-only sm:hidden">Quick add</span>
        </Button>
        <NotificationCenter />
        <Menu>
          <MenuTrigger aria-label="Account menu" className="rounded-full">
            <Avatar name={profile.fullName} src={profile.avatarUrl} />
          </MenuTrigger>
          <MenuContent>
            <div className="px-3 py-2">
              <p className="truncate text-sm font-medium">{profile.fullName}</p>
              <p className="truncate text-xs text-muted">{profile.email}</p>
            </div>
            <MenuSeparator />
            <MenuItem asChild>
              <Link href="/settings">
                <Settings /> Settings
              </Link>
            </MenuItem>
            <MenuItem
              onSelect={async () => {
                await api("/api/auth/logout", { body: {} }).catch(() => {});
                invalidate("/api/me");
                router.replace("/login");
              }}
            >
              <LogOut /> Sign out
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  // This tree only renders after /api/me resolves in the browser, so reading localStorage here
  // cannot cause a hydration mismatch.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [drawer, setDrawer] = useState(false);

  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {}
      return !c;
    });

  return (
    <QuickAddProvider>
      <TaskDialogsProvider>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <div className="flex min-h-screen">
        <aside
          className={cn(
            "sticky top-0 hidden h-screen shrink-0 border-r border-border bg-surface transition-[width] lg:block",
            collapsed ? "w-[72px]" : "w-64",
          )}
        >
          <Sidebar collapsed={collapsed} />
        </aside>
        <Dialog open={drawer} onOpenChange={setDrawer}>
          <DialogContent title="Navigation" side="left">
            <Sidebar onNavigate={() => setDrawer(false)} />
          </DialogContent>
        </Dialog>
        <div className="flex min-w-0 flex-1 flex-col">
          <VerifyBanner />
          <Topbar onMenu={() => setDrawer(true)} onToggle={toggle} />
          <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
            {children}
          </main>
        </div>
      </div>
      </TaskDialogsProvider>
    </QuickAddProvider>
  );
}
