import { randomUUID } from "node:crypto";
import { Router } from "express";
import {
  createTaskSchema,
  subtaskTitleSchema,
  taskDatesSchema,
  taskListQuerySchema,
  updateSubtaskSchema,
  updateTaskSchema,
  updateTaskStatusSchema,
  uuidSchema,
  zonedToUtc,
  type TaskDetail,
} from "@lifesync/shared";
import { requireAuth, uid } from "../auth/sessions";
import type { AppContext } from "../context";
import { withUser, type Db } from "../db/pool";
import { forbidden, handler, HttpError, notFound, parse } from "../http";
import {
  PRIORITY_ORDER_SQL,
  TASK_DETAIL_SQL,
  TASK_LIST_FROM,
  TASK_LIST_SQL,
  mapDetail,
  mapListItem,
} from "../services/tasks";
import { applyDefaultReminders, mapRule, saveRule, spawnNextOccurrence } from "../services/reminders";

const SORTS = {
  due: `(t.status in ('completed', 'cancelled')), t.due_date nulls last, t.due_time nulls last, ${PRIORITY_ORDER_SQL}, t.created_at desc`,
  priority: `(t.status in ('completed', 'cancelled')), ${PRIORITY_ORDER_SQL}, t.due_date nulls last, t.created_at desc`,
  created: `t.created_at desc`,
  title: `lower(t.title), t.created_at desc`,
} as const;

async function timezoneOf(db: Db, userId: string): Promise<string> {
  return (await db.query(`select timezone from profiles where id = $1`, [userId])).rows[0].timezone as string;
}

async function loadDetail(db: Db, id: string): Promise<TaskDetail> {
  const q = await db.query(`select ${TASK_DETAIL_SQL} ${TASK_LIST_FROM} where t.id = $1`, [id]);
  if (!q.rows[0]) throw notFound("Task not found");
  const subs = await db.query(`select id, title, is_done from subtasks where task_id = $1 order by sort_order, created_at`, [id]);
  const who = await db.query(
    `select a.user_id, p.full_name from task_assignees a join profiles p on p.id = a.user_id where a.task_id = $1 order by p.full_name`,
    [id],
  );
  const ruleId = (await db.query(`select recurring_rule_id from tasks where id = $1`, [id])).rows[0].recurring_rule_id;
  const rule = ruleId ? (await db.query(`select * from recurring_rules where id = $1`, [ruleId])).rows[0] : null;
  return mapDetail(
    q.rows[0],
    subs.rows.map((s) => ({ id: s.id, title: s.title, isDone: s.is_done })),
    who.rows.map((a) => ({ userId: a.user_id, fullName: a.full_name })),
    rule ? mapRule(rule) : null,
  );
}

async function loadItem(db: Db, id: string) {
  return mapListItem((await db.query(`select ${TASK_LIST_SQL} ${TASK_LIST_FROM} where t.id = $1`, [id])).rows[0]);
}

async function log(db: Db, workspaceId: string, actor: string, taskId: string, action: string, metadata: object = {}) {
  await db.query(
    `insert into activity_logs (workspace_id, actor_id, entity_type, entity_id, action, metadata)
     values ($1, $2, 'task', $3, $4, $5)`,
    [workspaceId, actor, taskId, action, JSON.stringify(metadata)],
  );
}

/** A project/category must belong to the task's workspace; the composite foreign key enforces it, this gives a clear message. */
function relationError(e: unknown): never {
  if ((e as { code?: string }).code === "23503") {
    throw new HttpError(422, "validation_failed", "Please check the highlighted fields", {
      projectId: "That project or category is not part of this workspace",
    });
  }
  throw e;
}

export function tasksRouter(_ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    "/",
    handler(async (req, res) => {
      const f = parse(taskListQuerySchema, req.query);
      const rows = await withUser(uid(req), async (db) => {
        const q = await db.query(
          `select ${TASK_LIST_SQL} ${TASK_LIST_FROM}
           where (t.archived_at is not null) = ($1::text = 'true')
             and ($2::uuid is null or t.workspace_id = $2)
             and ($3::text is null or ($3 = 'open' and t.status in ('todo', 'in_progress')) or t.status::text = $3)
             and ($4::task_priority is null or t.priority = $4)
             and ($5::uuid is null or t.project_id = $5)
             and ($6::uuid is null or t.category_id = $6)
             and ($7::text is null or $7 = any (t.tags))
             and ($8::text is null or t.title ilike '%' || replace(replace(replace($8, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')
           order by ${SORTS[f.sort]}
           limit $9`,
          [
            f.archived ?? "false",
            f.workspaceId ?? null,
            f.status ?? null,
            f.priority ?? null,
            f.projectId ?? null,
            f.categoryId ?? null,
            f.tag?.toLowerCase() || null,
            f.q || null,
            f.limit,
          ],
        );
        return q.rows.map(mapListItem);
      });
      res.json(rows);
    }),
  );

  r.post(
    "/",
    handler(async (req, res) => {
      const input = parse(createTaskSchema, req.body);
      const userId = uid(req);
      const id = randomUUID();
      const task = await withUser(userId, async (db) => {
        const ws = await db.query(`select 1 from workspace_members where workspace_id = $1 and user_id = $2`, [
          input.workspaceId,
          userId,
        ]);
        if (!ws.rows[0]) throw notFound("Workspace not found");
        const tz = await timezoneOf(db, userId);
        const dueAt = input.dueDate && input.dueTime ? zonedToUtc(input.dueDate, input.dueTime, tz) : null;
        const status = input.status ?? "todo";
        const ruleId = input.recurrence ? await saveRule(db, input.workspaceId, null, input.recurrence, input.dueDate!) : null;
        try {
          await db.query(
            `insert into tasks (id, workspace_id, title, description, notes, priority, status, project_id, category_id,
               start_date, start_time, due_date, due_time, due_at, estimated_minutes, actual_minutes, tags, completed_at, created_by, recurring_rule_id)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, case when $7::task_status = 'completed' then now() end, $18, $19)`,
            [
              id, input.workspaceId, input.title, input.description || null, input.notes || null,
              input.priority ?? "medium", status, input.projectId ?? null, input.categoryId ?? null,
              input.startDate ?? null, input.startTime ?? null, input.dueDate ?? null, input.dueTime ?? null, dueAt,
              input.estimatedMinutes ?? null, input.actualMinutes ?? 0, input.tags ?? [], userId, ruleId,
            ],
          );
        } catch (e) {
          relationError(e);
        }
        // The creator owns what they add, which is what puts it on their own My Day.
        await db.query(
          `insert into task_assignees (task_id, workspace_id, user_id, assigned_by) values ($1, $2, $3, $3)`,
          [id, input.workspaceId, userId],
        );
        await log(db, input.workspaceId, userId, id, "task.created");
        if (dueAt) await applyDefaultReminders(db, { id, workspaceId: input.workspaceId }, userId);
        return loadItem(db, id);
      });
      res.status(201).json(task);
    }),
  );

  r.get(
    "/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      res.json(await withUser(uid(req), (db) => loadDetail(db, id)));
    }),
  );

  r.patch(
    "/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const input = parse(updateTaskSchema, req.body);
      const task = await withUser(uid(req), async (db) => {
        const curQ = await db.query(
          `select *, start_date::text as sd, due_date::text as dd,
                  to_char(start_time, 'HH24:MI') as st, to_char(due_time, 'HH24:MI') as dt
           from tasks where id = $1 for update`,
          [id],
        );
        const cur = curQ.rows[0];
        if (!cur) throw notFound("Task not found");
        const tz = await timezoneOf(db, uid(req));

        // Fields absent from the request keep their current value; null clears.
        const m = {
          title: input.title ?? cur.title,
          description: "description" in input ? input.description || null : cur.description,
          notes: "notes" in input ? input.notes || null : cur.notes,
          priority: input.priority ?? cur.priority,
          status: input.status ?? cur.status,
          projectId: "projectId" in input ? input.projectId : cur.project_id,
          categoryId: "categoryId" in input ? input.categoryId : cur.category_id,
          startDate: "startDate" in input ? input.startDate! : (cur.sd as string | null),
          startTime: "startTime" in input ? input.startTime! : (cur.st as string | null),
          dueDate: "dueDate" in input ? input.dueDate! : (cur.dd as string | null),
          dueTime: "dueTime" in input ? input.dueTime! : (cur.dt as string | null),
          estimatedMinutes: "estimatedMinutes" in input ? input.estimatedMinutes : cur.estimated_minutes,
          actualMinutes: input.actualMinutes ?? cur.actual_minutes,
          tags: input.tags ?? cur.tags,
          recurrence: "recurrence" in input ? input.recurrence : cur.recurring_rule_id ? { existing: true } : null,
        };
        // Clearing the date also clears its time so the row stays valid.
        if (!m.dueDate) m.dueTime = null;
        if (!m.startDate) m.startTime = null;
        parse(taskDatesSchema, m);
        let ruleId: string | null = cur.recurring_rule_id;
        if ("recurrence" in input) {
          ruleId = input.recurrence ? await saveRule(db, cur.workspace_id, cur.recurring_rule_id, input.recurrence, m.dueDate!) : null;
        }

        const dueAt = m.dueDate && m.dueTime ? zonedToUtc(m.dueDate, m.dueTime, tz) : null;
        try {
          await db.query(
            `update tasks set title=$2, description=$3, notes=$4, priority=$5, status=$6::task_status, project_id=$7, category_id=$8,
               start_date=$9, start_time=$10, due_date=$11, due_time=$12, due_at=$13, estimated_minutes=$14, actual_minutes=$15, tags=$16,
               recurring_rule_id=$17,
               completed_at = case when $6::task_status = 'completed' then coalesce(completed_at, now()) else null end
             where id = $1`,
            [
              id, m.title, m.description, m.notes, m.priority, m.status, m.projectId, m.categoryId,
              m.startDate, m.startTime, m.dueDate, m.dueTime, dueAt, m.estimatedMinutes, m.actualMinutes, m.tags, ruleId,
            ],
          );
        } catch (e) {
          relationError(e);
        }
        await log(db, cur.workspace_id, uid(req), id, "task.updated", { fields: Object.keys(input) });
        if (["completed", "cancelled"].includes(m.status) && !["completed", "cancelled"].includes(cur.status)) {
          await spawnNextOccurrence(db, id, uid(req));
        }
        return loadDetail(db, id);
      });
      res.json(task);
    }),
  );

  r.patch(
    "/:id/status",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const { status } = parse(updateTaskStatusSchema, req.body);
      const task = await withUser(uid(req), async (db) => {
        const upd = await db.query(
          `update tasks set status = $2::task_status,
             completed_at = case when $2::task_status = 'completed' then coalesce(completed_at, now()) else null end
           where id = $1 returning workspace_id`,
          [id, status],
        );
        if (upd.rowCount === 0) throw notFound("Task not found");
        await log(db, upd.rows[0].workspace_id, uid(req), id, "task.status_changed", { status });
        if (status === "completed" || status === "cancelled") await spawnNextOccurrence(db, id, uid(req));
        return loadItem(db, id);
      });
      res.json(task);
    }),
  );

  r.post(
    "/:id/duplicate",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const userId = uid(req);
      const copyId = randomUUID();
      const task = await withUser(userId, async (db) => {
        const ins = await db.query(
          `insert into tasks (id, workspace_id, project_id, category_id, title, description, notes, priority, status,
             start_date, start_time, due_date, due_time, due_at, estimated_minutes, tags, created_by)
           select $2, workspace_id, project_id, category_id, left(title, 290) || ' (copy)', description, notes, priority, 'todo',
             start_date, start_time, due_date, due_time, due_at, estimated_minutes, tags, $3
           from tasks where id = $1 returning workspace_id`,
          [id, copyId, userId],
        );
        if (!ins.rows[0]) throw notFound("Task not found");
        const ws = ins.rows[0].workspace_id;
        await db.query(
          `insert into subtasks (task_id, workspace_id, title, sort_order)
           select $2, workspace_id, title, sort_order from subtasks where task_id = $1`,
          [id, copyId],
        );
        await db.query(`insert into task_assignees (task_id, workspace_id, user_id, assigned_by) values ($1, $2, $3, $3)`, [copyId, ws, userId]);
        await log(db, ws, userId, copyId, "task.created", { duplicatedFrom: id });
        if ((await db.query(`select due_at from tasks where id = $1`, [copyId])).rows[0].due_at) {
          await applyDefaultReminders(db, { id: copyId, workspaceId: ws }, userId);
        }
        return loadItem(db, copyId);
      });
      res.status(201).json(task);
    }),
  );

  for (const [path, archive] of [["archive", true], ["unarchive", false]] as const) {
    r.post(
      `/:id/${path}`,
      handler(async (req, res) => {
        const id = parse(uuidSchema, req.params.id);
        await withUser(uid(req), async (db) => {
          const upd = await db.query(
            `update tasks set archived_at = case when $2::boolean then now() else null end where id = $1 returning workspace_id`,
            [id, archive],
          );
          if (upd.rowCount === 0) throw notFound("Task not found");
          await log(db, upd.rows[0].workspace_id, uid(req), id, archive ? "task.archived" : "task.unarchived");
        });
        res.json({ ok: true });
      }),
    );
  }

  r.delete(
    "/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      await withUser(uid(req), async (db) => {
        const visible = await db.query(`select 1 from tasks where id = $1`, [id]);
        if (visible.rowCount === 0) throw notFound("Task not found");
        // The delete policy limits plain members to tasks they created.
        const del = await db.query(`delete from tasks where id = $1`, [id]);
        if (del.rowCount === 0) throw forbidden("Only the creator, a manager or an admin can delete this task");
      });
      res.json({ ok: true });
    }),
  );

  // ---- Subtasks / checklist ----

  r.post(
    "/:id/subtasks",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const { title } = parse(subtaskTitleSchema, req.body);
      const sub = await withUser(uid(req), async (db) => {
        const t = await db.query(`select workspace_id from tasks where id = $1`, [id]);
        if (!t.rows[0]) throw notFound("Task not found");
        const q = await db.query(
          `insert into subtasks (task_id, workspace_id, title, sort_order)
           values ($1, $2, $3, coalesce((select max(sort_order) from subtasks where task_id = $1), 0) + 1)
           returning id, title, is_done`,
          [id, t.rows[0].workspace_id, title],
        );
        return { id: q.rows[0].id, title: q.rows[0].title, isDone: q.rows[0].is_done };
      });
      res.status(201).json(sub);
    }),
  );

  r.patch(
    "/:id/subtasks/:subId",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const subId = parse(uuidSchema, req.params.subId);
      const input = parse(updateSubtaskSchema, req.body);
      const sub = await withUser(uid(req), async (db) => {
        const q = await db.query(
          `update subtasks set title = coalesce($3, title), is_done = coalesce($4, is_done)
           where id = $2 and task_id = $1 returning id, title, is_done`,
          [id, subId, input.title ?? null, input.isDone ?? null],
        );
        if (!q.rows[0]) throw notFound("Checklist item not found");
        return { id: q.rows[0].id, title: q.rows[0].title, isDone: q.rows[0].is_done };
      });
      res.json(sub);
    }),
  );

  r.delete(
    "/:id/subtasks/:subId",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const subId = parse(uuidSchema, req.params.subId);
      await withUser(uid(req), async (db) => {
        const q = await db.query(`delete from subtasks where id = $2 and task_id = $1`, [id, subId]);
        if (q.rowCount === 0) throw notFound("Checklist item not found");
      });
      res.json({ ok: true });
    }),
  );

  return r;
}
