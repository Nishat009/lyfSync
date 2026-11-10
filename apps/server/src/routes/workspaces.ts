import { randomUUID } from "node:crypto";
import { Router } from "express";
import {
  DEFAULT_ORGANIZATION_CATEGORIES,
  LIMITS,
  createOrganizationSchema,
  deleteWorkspaceSchema,
  inviteMemberSchema,
  updateMemberRoleSchema,
  updateWorkspaceSchema,
  uuidSchema,
  type CreatedInvitation,
  type Invitation,
  type Member,
  type WorkspaceDetail,
  type WorkspaceRole,
} from "@lifesync/shared";
import { seedCategories } from "../auth/accounts";
import { hashToken, newToken } from "../auth/crypto";
import { requireAuth, uid } from "../auth/sessions";
import type { AppContext } from "../context";
import { withUser, type Db } from "../db/pool";
import { conflict, forbidden, handler, notFound, parse } from "../http";
import { listWorkspaces } from "./me";

interface Access {
  type: "personal" | "organization";
  role: WorkspaceRole;
  name: string;
}

/** Returns the caller's role, or throws 404 (the workspace is invisible to non-members under RLS). */
async function access(db: Db, workspaceId: string): Promise<Access> {
  const q = await db.query(
    `select w.type, w.name, m.role from workspaces w
     join workspace_members m on m.workspace_id = w.id and m.user_id = app.current_user_id()
     where w.id = $1`,
    [workspaceId],
  );
  const row = q.rows[0];
  if (!row) throw notFound("Workspace not found");
  return { type: row.type, role: row.role, name: row.name };
}

function requireAdmin(a: Access): void {
  if (a.type !== "organization") throw forbidden("This action only applies to organizations");
  if (a.role !== "admin") throw forbidden("Only organization admins can do that");
}

function toInvitation(r: Record<string, any>): Invitation {
  const expired = r.status === "pending" && new Date(r.expires_at) < new Date();
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    status: expired ? "expired" : r.status,
    invitedByName: r.invited_by_name ?? null,
    expiresAt: new Date(r.expires_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export function workspacesRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    "/",
    handler(async (req, res) => {
      res.json(await withUser(uid(req), listWorkspaces));
    }),
  );

  r.post(
    "/",
    handler(async (req, res) => {
      const input = parse(createOrganizationSchema, req.body);
      const userId = uid(req);
      const id = randomUUID(); // chosen here because INSERT ... RETURNING would need SELECT access first
      const list = await withUser(userId, async (db) => {
        await db.query(
          `insert into workspaces (id, type, name, description, created_by) values ($1, 'organization', $2, $3, $4)`,
          [id, input.name, input.description || null, userId],
        );
        await db.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')`, [id, userId]);
        await seedCategories(db, id, DEFAULT_ORGANIZATION_CATEGORIES);
        return listWorkspaces(db);
      });
      res.status(201).json(list.find((w) => w.id === id));
    }),
  );

  r.get(
    "/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const body = await withUser(uid(req), async (db) => {
        await access(db, id);
        const ws = (await listWorkspaces(db)).find((w) => w.id === id)!;
        const created = await db.query(`select created_at from workspaces where id = $1`, [id]);
        const cats = await db.query(`select id, name, color from categories where workspace_id = $1 order by lower(name)`, [id]);
        const detail: WorkspaceDetail = { ...ws, createdAt: created.rows[0].created_at.toISOString(), categories: cats.rows };
        return detail;
      });
      res.json(body);
    }),
  );

  r.patch(
    "/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const input = parse(updateWorkspaceSchema, req.body);
      await withUser(uid(req), async (db) => {
        requireAdmin(await access(db, id));
        await db.query(`update workspaces set name = $2, description = $3 where id = $1`, [
          id,
          input.name,
          input.description || null,
        ]);
      });
      res.json({ ok: true });
    }),
  );

  r.delete(
    "/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const input = parse(deleteWorkspaceSchema, req.body);
      await withUser(uid(req), async (db) => {
        const a = await access(db, id);
        requireAdmin(a);
        if (input.confirmName !== a.name) {
          throw conflict("Type the organization name exactly to confirm deletion", "confirm_mismatch");
        }
        await db.query(`delete from workspaces where id = $1`, [id]);
      });
      res.json({ ok: true });
    }),
  );

  // ---- Members ----

  r.get(
    "/:id/members",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const members = await withUser(uid(req), async (db) => {
        await access(db, id);
        const q = await db.query(
          `select m.user_id, m.role, m.joined_at, p.full_name, p.email, p.avatar_path
           from workspace_members m join profiles p on p.id = m.user_id
           where m.workspace_id = $1
           order by (m.role = 'admin') desc, (m.role = 'manager') desc, lower(p.full_name)`,
          [id],
        );
        return q.rows.map(
          (m): Member => ({
            userId: m.user_id,
            fullName: m.full_name,
            email: m.email,
            avatarUrl: m.avatar_path ? `/api/avatars/${m.user_id}?v=${encodeURIComponent(m.avatar_path)}` : null,
            role: m.role,
            joinedAt: m.joined_at.toISOString(),
          }),
        );
      });
      res.json(members);
    }),
  );

  r.patch(
    "/:id/members/:userId",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const target = parse(uuidSchema, req.params.userId);
      const { role } = parse(updateMemberRoleSchema, req.body);
      await withUser(uid(req), async (db) => {
        requireAdmin(await access(db, id));
        const q = await db.query(`update workspace_members set role = $3 where workspace_id = $1 and user_id = $2`, [
          id,
          target,
          role,
        ]);
        if (q.rowCount === 0) throw notFound("Member not found");
      });
      res.json({ ok: true });
    }),
  );

  r.delete(
    "/:id/members/:userId",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const target = parse(uuidSchema, req.params.userId);
      await withUser(uid(req), async (db) => {
        const a = await access(db, id);
        if (a.type !== "organization") throw forbidden("Your personal workspace cannot be left");
        if (target !== uid(req)) requireAdmin(a); // anyone may leave; only admins remove others
        // The database refuses to remove the last admin (guard trigger -> 409) and drops the
        // member's task assignments (trigger from migration 0005).
        const q = await db.query(`delete from workspace_members where workspace_id = $1 and user_id = $2`, [id, target]);
        if (q.rowCount === 0) throw notFound("Member not found");
      });
      res.json({ ok: true });
    }),
  );

  // ---- Invitations (admins only) ----

  r.get(
    "/:id/invitations",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const list = await withUser(uid(req), async (db) => {
        requireAdmin(await access(db, id));
        const q = await db.query(
          `select i.*, p.full_name as invited_by_name from workspace_invitations i
           left join profiles p on p.id = i.invited_by
           where i.workspace_id = $1 order by i.created_at desc limit 100`,
          [id],
        );
        return q.rows.map(toInvitation);
      });
      res.json(list);
    }),
  );

  async function createOrRefresh(
    ctx2: AppContext,
    db: Db,
    workspaceId: string,
    userId: string,
    email: string,
    role: WorkspaceRole,
    workspaceName: string,
  ): Promise<CreatedInvitation> {
    await db.query(
      `update workspace_invitations set status = 'expired' where workspace_id = $1 and status = 'pending' and expires_at <= now()`,
      [workspaceId],
    );
    const member = await db.query(
      `select 1 from workspace_members m join profiles p on p.id = m.user_id where m.workspace_id = $1 and p.email = $2`,
      [workspaceId, email],
    );
    if (member.rowCount) throw conflict("That person is already a member", "already_member");

    const token = newToken();
    const id = randomUUID();
    try {
      await db.query(
        `insert into workspace_invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at)
         values ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval)`,
        [id, workspaceId, email, role, hashToken(token), userId, String(LIMITS.invitationTtlDays)],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        throw conflict("There is already a pending invitation for that email", "already_invited");
      }
      throw e;
    }
    const row = (
      await db.query(
        `select i.*, p.full_name as invited_by_name from workspace_invitations i
         left join profiles p on p.id = i.invited_by where i.id = $1`,
        [id],
      )
    ).rows[0];
    const inviteUrl = `${ctx2.config.APP_URL}/invite?token=${token}`;
    const inviter = row.invited_by_name ?? "A teammate";
    let emailSent = false;
    try {
      emailSent = await ctx2.mailer.send({
        to: email,
        subject: `${inviter} invited you to ${workspaceName} on LifeSync`,
        text: `${inviter} invited you to join "${workspaceName}" as ${role}.\n\nAccept the invitation: ${inviteUrl}\n\nThe link works for ${LIMITS.invitationTtlDays} days and only for this email address.`,
      });
    } catch (e) {
      ctx2.log("invitation email failed", e);
    }
    return { invitation: toInvitation(row), inviteUrl, emailSent };
  }

  r.post(
    "/:id/invitations",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const input = parse(inviteMemberSchema, req.body);
      const created = await withUser(uid(req), async (db) => {
        const a = await access(db, id);
        requireAdmin(a);
        return createOrRefresh(ctx, db, id, uid(req), input.email, input.role, a.name);
      });
      res.status(201).json(created);
    }),
  );

  // Resend = revoke the old link and issue a fresh one (the raw token is never stored).
  r.post(
    "/:id/invitations/:invitationId/resend",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const invitationId = parse(uuidSchema, req.params.invitationId);
      const created = await withUser(uid(req), async (db) => {
        const a = await access(db, id);
        requireAdmin(a);
        const old = await db.query(
          `update workspace_invitations set status = 'revoked', responded_at = now()
           where id = $1 and workspace_id = $2 and status = 'pending' returning email, role`,
          [invitationId, id],
        );
        const row = old.rows[0];
        if (!row) throw notFound("Invitation not found or no longer pending");
        return createOrRefresh(ctx, db, id, uid(req), row.email, row.role, a.name);
      });
      res.status(201).json(created);
    }),
  );

  r.delete(
    "/:id/invitations/:invitationId",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const invitationId = parse(uuidSchema, req.params.invitationId);
      await withUser(uid(req), async (db) => {
        requireAdmin(await access(db, id));
        const q = await db.query(
          `update workspace_invitations set status = 'revoked', responded_at = now()
           where id = $1 and workspace_id = $2 and status = 'pending'`,
          [invitationId, id],
        );
        if (q.rowCount === 0) throw notFound("Invitation not found or no longer pending");
      });
      res.json({ ok: true });
    }),
  );

  return r;
}
