"use client";

import {
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  WORKSPACE_ROLES,
  inviteMemberSchema,
  type CreatedInvitation,
  type InviteMemberInput,
  type Invitation,
  type Member,
} from "@lifesync/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { Copy, Mail, RotateCw, Trash2, UserMinus } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useSession, useWorkspace } from "@/components/app/session";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, EmptyState, ErrorState, Skeleton } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { api, applyFormError } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/use-query";
import { formatDay } from "@/lib/utils";

function InviteForm({ workspaceId }: { workspaceId: string }) {
  const [formError, setFormError] = useState<string | null>(null);
  const [link, setLink] = useState<CreatedInvitation | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<InviteMemberInput>({ resolver: zodResolver(inviteMemberSchema), defaultValues: { role: "member" } });

  return (
    <Card>
      <CardHeader title="Invite someone" description="They'll get an email with a link that only works for their address." />
      <form
        noValidate
        className="space-y-4 px-5 pb-5"
        onSubmit={handleSubmit(async (values) => {
          setFormError(null);
          try {
            const created = await api<CreatedInvitation>(`/api/workspaces/${workspaceId}/invitations`, { body: values });
            invalidate(`/api/workspaces/${workspaceId}/invitations`);
            setLink(created);
            reset({ email: "", role: values.role });
            toast.success(created.emailSent ? "Invitation emailed" : "Invitation created");
          } catch (e) {
            setFormError(applyFormError(e, setError));
          }
        })}
      >
        <FormError message={formError} />
        <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto] sm:items-end">
          <Field label="Email" error={errors.email?.message}>
            {(p) => <Input type="email" placeholder="teammate@company.com" {...p} {...register("email")} />}
          </Field>
          <Field label="Role">
            {(p) => (
              <Select {...p} {...register("role")}>
                {WORKSPACE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" variant="work" loading={isSubmitting}>
            <Mail /> Send invite
          </Button>
        </div>
      </form>
      {link && (
        <div className="mx-5 mb-5 rounded-lg bg-surface-muted p-3 text-xs">
          <p className="mb-1.5 text-muted">
            {link.emailSent ? "Email sent. You can also share this link directly:" : "Email isn't configured here, so share this link yourself:"}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate">{link.inviteUrl}</code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigator.clipboard.writeText(link.inviteUrl).then(() => toast.success("Link copied"))}
            >
              <Copy /> Copy
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function Invitations({ workspaceId }: { workspaceId: string }) {
  const key = `/api/workspaces/${workspaceId}/invitations`;
  const { data, error, loading, reload } = useQuery<Invitation[]>(key);
  const pending = data?.filter((i) => i.status === "pending") ?? [];
  const [shown, setShown] = useState<CreatedInvitation | null>(null);

  return (
    <Card>
      <CardHeader title="Pending invitations" />
      {loading && !data ? (
        <Skeleton className="m-5 mt-0 h-12" />
      ) : error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : pending.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted">No pending invitations.</p>
      ) : (
        <ul className="divide-y divide-border">
          {pending.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{i.email}</p>
                <p className="text-xs text-muted">
                  {ROLE_LABELS[i.role]} · expires {formatDay(i.expiresAt.slice(0, 10))}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    const created = await api<CreatedInvitation>(`${key}/${i.id}/resend`, { body: {} });
                    invalidate(key);
                    setShown(created);
                    toast.success("A fresh invitation was sent");
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Could not resend");
                  }
                }}
              >
                <RotateCw /> Resend
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Revoke invitation for ${i.email}`}
                onClick={async () => {
                  try {
                    await api(`${key}/${i.id}`, { method: "DELETE" });
                    invalidate(key);
                    toast.success("Invitation revoked");
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Could not revoke");
                  }
                }}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {shown && (
        <p className="mx-5 mb-5 break-all rounded-lg bg-surface-muted p-3 text-xs">
          New link: <code>{shown.inviteUrl}</code>
        </p>
      )}
    </Card>
  );
}

export default function MembersPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useSession();
  const workspace = useWorkspace(id);
  const membersKey = `/api/workspaces/${id}/members`;
  const { data, error, loading, reload } = useQuery<Member[]>(workspace ? membersKey : null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");

  if (!workspace || workspace.type !== "organization") {
    return (
      <Card>
        <EmptyState title="No members to manage" description="Your personal workspace is private to you." />
      </Card>
    );
  }
  const isAdmin = workspace.role === "admin";

  const changeRole = async (m: Member, role: string) => {
    try {
      await api(`${membersKey}/${m.userId}`, { method: "PATCH", body: { role } });
      invalidate(membersKey);
      invalidate("/api/me");
      toast.success("Role updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the role");
      invalidate(membersKey);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
          <p className="mt-1 text-sm text-muted">
            {workspace.name} · you are {ROLE_LABELS[workspace.role].toLowerCase()}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader
          title={(() => {
            const n = data?.length ?? workspace.memberCount;
            return `${n} ${n === 1 ? "member" : "members"}`;
          })()}
        />
        {loading && !data ? (
          <div className="space-y-3 p-5 pt-0">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : error ? (
          <ErrorState message={error.message} onRetry={reload} />
        ) : (
          <ul className="divide-y divide-border">
            {data?.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Avatar name={m.fullName} src={m.avatarUrl} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {m.fullName} {m.userId === user.id && <Badge className="ml-1">You</Badge>}
                  </p>
                  <p className="truncate text-xs text-muted">{m.email}</p>
                </div>
                {isAdmin ? (
                  <Select
                    className="h-9 w-32"
                    aria-label={`Role for ${m.fullName}`}
                    value={m.role}
                    onChange={(e) => changeRole(m, e.target.value)}
                  >
                    {WORKSPACE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Badge tone="work">{ROLE_LABELS[m.role]}</Badge>
                )}
                {(isAdmin || m.userId === user.id) && (
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(m)}>
                    <UserMinus /> {m.userId === user.id ? "Leave" : "Remove"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <details className="border-t border-border px-5 py-3 text-xs text-muted">
          <summary className="cursor-pointer">What can each role do?</summary>
          <ul className="mt-2 space-y-1">
            {WORKSPACE_ROLES.map((r) => (
              <li key={r}>
                <strong className="text-foreground">{ROLE_LABELS[r]}</strong>: {ROLE_DESCRIPTIONS[r]}
              </li>
            ))}
          </ul>
          <p className="mt-2">Organization roles never grant access to anyone&apos;s personal workspace.</p>
        </details>
      </Card>

      {isAdmin && (
        <>
          <InviteForm workspaceId={id} />
          <Invitations workspaceId={id} />
          <Card className="border-danger/30">
            <CardHeader title="Delete organization" description="Permanently removes all of its tasks, projects and memberships." />
            <div className="px-5 pb-5">
              <Button variant="danger" onClick={() => setDeleteOpen(true)}>
                Delete organization
              </Button>
            </div>
          </Card>
        </>
      )}

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing?.userId === user.id ? `Leave ${workspace.name}?` : `Remove ${removing?.fullName}?`}
        description={
          removing?.userId === user.id
            ? "You'll lose access to this organization's tasks. Your personal workspace is not affected."
            : "They'll lose access to this organization immediately. Their personal workspace is not affected."
        }
        confirmLabel={removing?.userId === user.id ? "Leave" : "Remove"}
        destructive
        onConfirm={async () => {
          const m = removing!;
          try {
            await api(`${membersKey}/${m.userId}`, { method: "DELETE" });
            invalidate("/api/me");
            if (m.userId === user.id) router.replace("/my-day");
            else invalidate(membersKey);
            toast.success(m.userId === user.id ? "You left the organization" : "Member removed");
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not remove the member");
          }
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(o) => {
          setDeleteOpen(o);
          if (!o) setConfirmName("");
        }}
        title="Delete this organization?"
        description={`This cannot be undone. Type "${workspace.name}" to confirm.`}
        confirmLabel="Delete forever"
        destructive
        confirmDisabled={confirmName !== workspace.name}
        onConfirm={async () => {
          try {
            await api(`/api/workspaces/${id}`, { method: "DELETE", body: { confirmName } });
            invalidate("/api/me");
            router.replace("/my-day");
            toast.success("Organization deleted");
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not delete");
            throw e;
          }
        }}
      >
        <Input
          aria-label="Organization name"
          className="mb-4"
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
          autoComplete="off"
        />
      </ConfirmDialog>
    </div>
  );
}
