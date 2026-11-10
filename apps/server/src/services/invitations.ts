import type { MyInvitation } from "@lifesync/shared";
import { withSystem } from "../db/pool";

/**
 * Invitations are addressed to an email. Only an account whose email is verified may list or
 * accept them by id, otherwise anyone could register with a victim's address and join in their
 * place. (A token from the invitation email itself proves inbox access and needs no verification.)
 */
export async function countPendingInvitations(email: string, emailVerified: boolean): Promise<number> {
  if (!emailVerified) return 0;
  return withSystem(async (db) => {
    const q = await db.query(
      `select count(*)::int as n from workspace_invitations where email = $1 and status = 'pending' and expires_at > now()`,
      [email],
    );
    return q.rows[0].n as number;
  });
}

export async function listMyInvitations(email: string, emailVerified: boolean): Promise<MyInvitation[]> {
  if (!emailVerified) return [];
  return withSystem(async (db) => {
    const q = await db.query(
      `select i.id, i.workspace_id, w.name as workspace_name, p.full_name as invited_by_name, i.role, i.expires_at
       from workspace_invitations i
       join workspaces w on w.id = i.workspace_id
       left join profiles p on p.id = i.invited_by
       where i.email = $1 and i.status = 'pending' and i.expires_at > now()
       order by i.created_at desc`,
      [email],
    );
    return q.rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      workspaceName: r.workspace_name,
      invitedByName: r.invited_by_name,
      role: r.role,
      expiresAt: r.expires_at.toISOString(),
    }));
  });
}
