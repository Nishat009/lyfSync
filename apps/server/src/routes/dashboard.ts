import { Router } from "express";
import { z } from "zod";
import {
  addDays,
  localDate,
  uuidSchema,
  zonedToUtc,
  type DashboardData,
  type DashboardScope,
  type TaskPriority,
} from "@lifesync/shared";
import { requireAuth, uid } from "../auth/sessions";
import type { AppContext } from "../context";
import { withUser } from "../db/pool";
import { handler, notFound, parse } from "../http";
import { PRIORITY_ORDER_SQL, TASK_SUMMARY_FROM, TASK_SUMMARY_SQL, mapTask } from "../services/tasks";

/**
 * Scope of a dashboard query ($1 = workspace id or null).
 *  - one workspace: everything the caller may see there (RLS already hides what they may not);
 *  - combined "My Day": all personal tasks plus organization tasks assigned to the caller.
 */
const SCOPE_SQL = `
  t.archived_at is null and (
    ($1::uuid is null and (
      w.type = 'personal'
      or exists (select 1 from task_assignees a where a.task_id = t.id and a.user_id = app.current_user_id())
    ))
    or t.workspace_id = $1
  )`;

const OPEN = `t.status in ('todo', 'in_progress')`;

export function dashboardRouter(_ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    "/",
    handler(async (req, res) => {
      const { workspaceId } = parse(z.object({ workspaceId: uuidSchema.optional() }), req.query);
      const userId = uid(req);

      const data = await withUser(userId, async (db) => {
        const tz = (await db.query(`select timezone from profiles where id = $1`, [userId])).rows[0].timezone as string;
        const now = new Date();
        const today = localDate(now, tz);
        const weekStart = addDays(today, -6);
        const weekStartUtc = zonedToUtc(weekStart, "00:00", tz);

        let scope: DashboardScope = { type: "all" };
        if (workspaceId) {
          const ws = await db.query(`select id, type, name from workspaces where id = $1`, [workspaceId]);
          if (!ws.rows[0]) throw notFound("Workspace not found");
          scope = { type: "workspace", workspaceId, workspaceType: ws.rows[0].type, workspaceName: ws.rows[0].name };
        }
        const base = `${TASK_SUMMARY_FROM} where ${SCOPE_SQL}`;
        const wsParam = workspaceId ?? null;

        const [todayQ, overdueQ, upcomingQ, aggQ, dueWeekQ, doneWeekQ] = await Promise.all([
          // One client: pg queues these and runs them in order on the same transaction.
          db.query(
            `select ${TASK_SUMMARY_SQL} ${base} and t.due_date = $2::date and t.status <> 'cancelled'
             order by t.due_time nulls first, ${PRIORITY_ORDER_SQL}, t.created_at`,
            [wsParam, today],
          ),
          db.query(
            `select ${TASK_SUMMARY_SQL} ${base} and ${OPEN} and t.due_date < $2::date
             order by t.due_date, t.due_time nulls first, ${PRIORITY_ORDER_SQL} limit 20`,
            [wsParam, today],
          ),
          db.query(
            `select ${TASK_SUMMARY_SQL} ${base} and ${OPEN} and t.due_date > $2::date and t.due_date <= $3::date
             order by t.due_date, t.due_time nulls first, ${PRIORITY_ORDER_SQL} limit 10`,
            [wsParam, today, addDays(today, 7)],
          ),
          db.query(
            `select
               count(*) filter (where t.status <> 'cancelled' and t.due_date = $2::date)::int as total,
               count(*) filter (where t.status = 'completed' and t.due_date = $2::date)::int as completed,
               count(*) filter (where ${OPEN} and t.due_date < $2::date)::int as overdue,
               count(*) filter (where ${OPEN} and w.type = 'organization')::int as open_work,
               count(*) filter (where ${OPEN} and w.type = 'personal')::int as open_personal,
               count(*) filter (where t.status = 'completed' and t.completed_at >= $3 and w.type = 'organization')::int as done_work,
               count(*) filter (where t.status = 'completed' and t.completed_at >= $3 and w.type = 'personal')::int as done_personal,
               count(*) filter (where ${OPEN} and t.priority = 'urgent')::int as p_urgent,
               count(*) filter (where ${OPEN} and t.priority = 'high')::int as p_high,
               count(*) filter (where ${OPEN} and t.priority = 'medium')::int as p_medium,
               count(*) filter (where ${OPEN} and t.priority = 'low')::int as p_low
             from tasks t join workspaces w on w.id = t.workspace_id where ${SCOPE_SQL}`,
            [wsParam, today, weekStartUtc],
          ),
          db.query(
            `select t.due_date::text as d, count(*)::int as n
             from tasks t join workspaces w on w.id = t.workspace_id
             where ${SCOPE_SQL} and t.status <> 'cancelled' and t.due_date between $2::date and $3::date
             group by 1`,
            [wsParam, weekStart, today],
          ),
          db.query(
            `select (t.completed_at at time zone $3::text)::date::text as d, count(*)::int as n
             from tasks t join workspaces w on w.id = t.workspace_id
             where ${SCOPE_SQL} and t.status = 'completed' and t.completed_at >= $2
             group by 1`,
            [wsParam, weekStartUtc, tz],
          ),
        ]);

        const agg = aggQ.rows[0];
        const todayAll = todayQ.rows.map(mapTask);
        const dueByDay = new Map<string, number>(dueWeekQ.rows.map((x) => [x.d as string, x.n as number]));
        const doneByDay = new Map<string, number>(doneWeekQ.rows.map((x) => [x.d as string, x.n as number]));

        const body: DashboardData = {
          today,
          timezone: tz,
          scope,
          summary: {
            total: agg.total,
            completed: agg.completed,
            pending: agg.total - agg.completed,
            overdue: agg.overdue,
            progress: agg.total ? Math.round((agg.completed / agg.total) * 100) : 0,
          },
          todayTasks: todayAll.filter((t) => !t.dueTime),
          schedule: todayAll.filter((t) => t.dueTime),
          overdueTasks: overdueQ.rows.map(mapTask),
          upcomingTasks: upcomingQ.rows.map(mapTask),
          balance: {
            open: { work: agg.open_work, personal: agg.open_personal },
            completedLast7Days: { work: agg.done_work, personal: agg.done_personal },
          },
          openByPriority: { urgent: agg.p_urgent, high: agg.p_high, medium: agg.p_medium, low: agg.p_low } satisfies Record<
            TaskPriority,
            number
          >,
          weekly: Array.from({ length: 7 }, (_, i) => {
            const date = addDays(weekStart, i);
            return { date, completed: doneByDay.get(date) ?? 0, due: dueByDay.get(date) ?? 0 };
          }),
        };
        return body;
      });
      res.json(data);
    }),
  );

  return r;
}
