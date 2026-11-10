import { Router } from "express";
import { z } from "zod";
import { respondToInvitationSchema, type InvitationPreview } from "@lifesync/shared";
import { hashToken } from "../auth/crypto";
import { requireAuth, uid } from "../auth/sessions";
import type { AppContext } from "../context";
import { withSystem, type Db } from "../db/pool";
import { forbidden, handler, notFound, parse } from "../http";
import { listMyInvitations } from "../services/invitations";

interface InvitationRow {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  status: string;
  expires_at: Date;
}

/**
 * Loads and locks an invitation for the signed-in user. Authorization rules:
 *  - the invitation must be pending and unexpired;
 *  - it must be addressed to the signed-in account's email;
 *  - by id: that email must be verified; by token: possession of the emailed token is the proof.
 */
async function loadForUser(
  db: Db,
  userId: string,
  input: { token: string } | { invitationId: string },
): Promise<InvitationRow> {
  const me = (await db.query(`select email, email_verified_at from users where id = $1`, [userId])).rows[0];
  const byToken = "token" in input;
  const q = await db.query<InvitationRow>(
    byToken
      ? `select id, workspace_id, email, role, status, expires_at from workspace_invitations where token_hash = $1 for update`
      : `select id, workspace_id, email, role, status, expires_at from workspace_invitations where id = $1 for update`,
    [byToken ? hashToken(input.token) : input.invitationId],
  );
  const inv = q.rows[0];
  // Same answer for "does not exist" and "belongs to someone else" so ids cannot be probed.
  if (!inv || inv.email.toLowerCase() !== me.email.toLowerCase()) throw notFound("Invitation not found");
  if (!byToken && !me.email_verified_at) throw forbidden("Confirm your email address to accept invitations");
  if (inv.status !== "pending") throw notFound("This invitation is no longer available");
  if (inv.expires_at <= new Date()) {
    await db.query(`update workspace_invitations set status = 'expired' where id = $1`, [inv.id]);
    throw notFound("This invitation has expired");
  }
  return inv;
}

export function invitationsRouter(_ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    "/mine",
    handler(async (req, res) => {
      const me = await withSystem(async (db) => {
        const q = await db.query(`select email, email_verified_at from users where id = $1`, [uid(req)]);
        return q.rows[0];
      });
      res.json(await listMyInvitations(me.email, me.email_verified_at !== null));
    }),
  );

  // Look at an invitation link before accepting it. Only reveals data to the addressee.
  r.post(
    "/preview",
    handler(async (req, res) => {
      const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
      const preview = await withSystem(async (db) => {
        const me = (await db.query(`select email from users where id = $1`, [uid(req)])).rows[0];
        const q = await db.query(
          `select i.email, i.role, i.status, i.expires_at, w.name as workspace_name, p.full_name as invited_by_name
           from workspace_invitations i
           join workspaces w on w.id = i.workspace_id
           left join profiles p on p.id = i.invited_by
           where i.token_hash = $1`,
          [hashToken(token)],
        );
        const row = q.rows[0];
        if (!row || row.email.toLowerCase() !== me.email.toLowerCase()) return null;
        const expired = row.status === "pending" && row.expires_at <= new Date();
        const body: InvitationPreview = {
          workspaceName: row.workspace_name,
          invitedByName: row.invited_by_name,
          email: row.email,
          role: row.role,
          status: expired ? "expired" : row.status,
          expiresAt: row.expires_at.toISOString(),
        };
        return body;
      });
      if (!preview) throw notFound("This invitation was not sent to your account");
      res.json(preview);
    }),
  );

  r.post(
    "/accept",
    handler(async (req, res) => {
      const input = parse(respondToInvitationSchema, req.body);
      const workspaceId = await withSystem(async (db) => {
        const inv = await loadForUser(db, uid(req), input);
        await db.query(
          `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)
           on conflict (workspace_id, user_id) do nothing`,
          [inv.workspace_id, uid(req), inv.role],
        );
        await db.query(
          `update workspace_invitations set status = 'accepted', accepted_by = $2, responded_at = now() where id = $1`,
          [inv.id, uid(req)],
        );
        await db.query(
          `insert into activity_logs (workspace_id, actor_id, entity_type, entity_id, action, metadata)
           values ($1, $2, 'member', $2, 'member.joined', jsonb_build_object('role', $3::text))`,
          [inv.workspace_id, uid(req), inv.role],
        );
        return inv.workspace_id;
      });
      res.json({ workspaceId });
    }),
  );

  r.post(
    "/decline",
    handler(async (req, res) => {
      const input = parse(respondToInvitationSchema, req.body);
      await withSystem(async (db) => {
        const inv = await loadForUser(db, uid(req), input);
        await db.query(`update workspace_invitations set status = 'declined', responded_at = now() where id = $1`, [inv.id]);
      });
      res.json({ ok: true });
    }),
  );

  return r;
}
