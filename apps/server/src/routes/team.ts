import { Router } from "express";
import { localDate, uuidSchema, type TeamOverview } from "@lifesync/shared";
import { z } from "zod";
import { requireAuth, uid } from "../auth/sessions";
import type { AppContext } from "../context";
import { withUser } from "../db/pool";
import { forbidden, handler, notFound, parse } from "../http";
import { ACTIVITY_SQL, isManager, mapActivity, workspaceAccess } from "../services/collab";
import { avatarUrl } from "../services/tasks";

const feedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(40),
  before: z.iso.datetime().optional(),
});

/** Manager views of an organization: who is working on what, and what has been happening. */
export function teamRouter(_ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    "/:id/team",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const out = await withUser(uid(req), async (db): Promise<TeamOverview> => {
        const access = await workspaceAccess(db, id);
        if (!access) throw notFound("Workspace not found");
        if (access.type !== "organization") throw forbidden("Team views only apply to organizations");
        if (!isManager(access)) throw forbidden("Only managers and admins can see the team overview");

        const tz = (await db.query(`select timezone from profiles where id = $1`, [uid(req)])).rows[0].timezone as string;
        const today = localDate(Date.now(), tz);
        const weekAgo = new Date(Date.now() - 7 * 86_400_000);

        const members = await db.query(
          `select m.user_id, m.role, p.full_name, p.avatar_path,
             count(t.id) filter (where t.status in ('todo', 'in_progress'))::int as open,
             count(t.id) filter (where t.status = 'in_progress')::int as in_progress,
             count(t.id) filter (where t.status in ('todo', 'in_progress') and t.due_date = $2::date)::int as due_today,
             count(t.id) filter (where t.status in ('todo', 'in_progress') and t.due_date < $2::date)::int as overdue,
             count(t.id) filter (where t.status = 'completed' and t.completed_at >= $3::timestamptz)::int as completed_7d
           from workspace_members m
           join profiles p on p.id = m.user_id
           left join task_assignees a on a.workspace_id = m.workspace_id and a.user_id = m.user_id
           left join tasks t on t.workspace_id = a.workspace_id and t.id = a.task_id and t.archived_at is null
           where m.workspace_id = $1
           group by m.user_id, m.role, p.full_name, p.avatar_path
           order by open desc, lower(p.full_name)`,
          [id, today, weekAgo],
        );
        const unassigned = await db.query(
          `select count(*)::int as n from tasks t
           where t.workspace_id = $1 and t.archived_at is null and t.status in ('todo', 'in_progress')
             and not exists (select 1 from task_assignees a where a.task_id = t.id)`,
          [id],
        );
        // Totals count each task once, however many people share it.
        const totals = await db.query(
          `select count(*) filter (where status in ('todo', 'in_progress'))::int as open,
                  count(*) filter (where status in ('todo', 'in_progress') and due_date < $2::date)::int as overdue,
                  count(*) filter (where status = 'completed' and completed_at >= $3::timestamptz)::int as completed_7d
           from tasks where workspace_id = $1 and archived_at is null`,
          [id, today, weekAgo],
        );
        return {
          today,
          members: members.rows.map((m) => ({
            userId: m.user_id,
            fullName: m.full_name,
            avatarUrl: avatarUrl(m.user_id, m.avatar_path),
            role: m.role,
            open: m.open,
            inProgress: m.in_progress,
            dueToday: m.due_today,
            overdue: m.overdue,
            completedLast7Days: m.completed_7d,
          })),
          unassignedOpen: unassigned.rows[0].n,
          totals: { open: totals.rows[0].open, overdue: totals.rows[0].overdue, completedLast7Days: totals.rows[0].completed_7d },
        };
      });
      res.json(out);
    }),
  );

  r.get(
    "/:id/activity",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const q = parse(feedQuery, req.query);
      const out = await withUser(uid(req), async (db) => {
        const access = await workspaceAccess(db, id);
        if (!access) throw notFound("Workspace not found");
        if (!isManager(access)) throw forbidden("Only managers and admins can see workspace activity");
        const rows = await db.query(
          `${ACTIVITY_SQL}
           where a.workspace_id = $1 and ($2::timestamptz is null or a.created_at < $2::timestamptz)
           order by a.created_at desc, a.id limit $3`,
          [id, q.before ?? null, q.limit],
        );
        return rows.rows.map(mapActivity);
      });
      res.json(out);
    }),
  );

  return r;
}
