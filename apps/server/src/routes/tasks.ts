import { randomUUID } from "node:crypto";
import { Router } from "express";
import {
  commentSchema,
  createTaskSchema,
  setAssigneesSchema,
  subtaskTitleSchema,
  taskDatesSchema,
  taskListQuerySchema,
  updateSubtaskSchema,
  updateTaskSchema,
  updateTaskStatusSchema,
  uuidSchema,
  zonedToUtc,
  type ActivityEntry,
  type TaskComment,
  type TaskDetail,
} from "@lifesync/shared";
import { requireAuth, uid } from "../auth/sessions";
import type { AppContext } from "../context";
import { withUser, type Db } from "../db/pool";
import { forbidden, handler, HttpError, notFound, parse } from "../http";
import {
  ACTIVITY_SQL,
  dropRemindersFor,
  isManager,
  logActivity,
  mapActivity,
  notify,
  taskPermissions,
  workspaceAccess,
} from "../services/collab";
import {
  PRIORITY_ORDER_SQL,
  TASK_DETAIL_SQL,
  TASK_LIST_FROM,
  TASK_LIST_SQL,
  avatarUrl,
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

async function loadDetail(db: Db, id: string, userId: string): Promise<TaskDetail> {
  const q = await db.query(`select ${TASK_DETAIL_SQL} ${TASK_LIST_FROM} where t.id = $1`, [id]);
  if (!q.rows[0]) throw notFound("Task not found");
  const subs = await db.query(`select id, title, is_done from subtasks where task_id = $1 order by sort_order, created_at`, [id]);
  const ruleId = (await db.query(`select recurring_rule_id from tasks where id = $1`, [id])).rows[0].recurring_rule_id;
  const rule = ruleId ? (await db.query(`select * from recurring_rules where id = $1`, [ruleId])).rows[0] : null;
  const access = await workspaceAccess(db, q.rows[0].workspace_id);
  if (!access) throw notFound("Task not found");
  return mapDetail(
    q.rows[0],
    subs.rows.map((s) => ({ id: s.id, title: s.title, isDone: s.is_done })),
    rule ? mapRule(rule) : null,
    taskPermissions(access, q.rows[0].created_by_id, userId),
  );
}

/** Loads a task's workspace, creator and the caller's rights; 404 when the task is not visible to them. */
async function taskContext(db: Db, id: string, userId: string) {
  const t = await db.query(`select workspace_id, created_by, title from tasks where id = $1`, [id]);
  if (!t.rows[0]) throw notFound("Task not found");
  const access = await workspaceAccess(db, t.rows[0].workspace_id);
  if (!access) throw notFound("Task not found");
  return {
    workspaceId: t.rows[0].workspace_id as string,
    createdBy: t.rows[0].created_by as string | null,
    title: t.rows[0].title as string,
    access,
    can: taskPermissions(access, t.rows[0].created_by, userId),
  };
}

async function loadItem(db: Db, id: string) {
  return mapListItem((await db.query(`select ${TASK_LIST_SQL} ${TASK_LIST_FROM} where t.id = $1`, [id])).rows[0]);
}

function log(db: Db, workspaceId: string, actor: string, taskId: string, action: string, metadata: object = {}) {
  return logActivity(db, workspaceId, actor, "task", taskId, action, metadata);
}

const REASSIGN_HINT = "Only the person who created this task, a manager or an admin can change that";

/** A project/category must belong to the task's workspace; the composite foreign key enforces it, this gives a clear message. */
function relationError(e: unknown): never {
  if ((e as { code?: string }).code === "23503") {
    throw new HttpError(422, "validation_failed", "Please check the highlighted fields", {
      projectId: "That project or category is not part of this workspace",
    });
  }
  throw e;
}

async function nameOf(db: Db, userId: string): Promise<string> {
  return (await db.query(`select full_name from profiles where id = $1`, [userId])).rows[0]?.full_name ?? "Someone";
}

/** Adds people to a task. The database trigger rejects anybody who is not a member of the workspace. */
async function addAssignees(db: Db, taskId: string, workspaceId: string, userIds: string[], by: string) {
  for (const u of userIds) {
    try {
      await db.query(
        `insert into task_assignees (task_id, workspace_id, user_id, assigned_by) values ($1, $2, $3, $4) on conflict do nothing`,
        [taskId, workspaceId, u, by],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23514") {
        throw new HttpError(422, "validation_failed", "Please check the highlighted fields", {
          assigneeIds: "You can only assign tasks to members of this workspace",
        });
      }
      throw e;
    }
  }
}

export function tasksRouter(ctx: AppContext): Router {
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
             and ($10::text = 'any'
               or ($10 = 'none' and not exists (select 1 from task_assignees a where a.task_id = t.id))
               or ($10 = 'user' and exists (select 1 from task_assignees a where a.task_id = t.id and a.user_id = $11::uuid)))
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
            !f.assignee ? "any" : f.assignee === "none" ? "none" : "user",
            !f.assignee || f.assignee === "none" ? null : f.assignee === "me" ? uid(req) : f.assignee,
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
      let toNotify: { userIds: string[]; by: string; title: string } | null = null;
      const task = await withUser(userId, async (db) => {
        const access = await workspaceAccess(db, input.workspaceId);
        if (!access) throw notFound("Workspace not found");
        // The creator owns what they add (which is what puts it on their My Day) unless a manager
        // chooses other people on purpose.
        const assignees = [...new Set(input.assigneeIds ?? [userId])];
        if (assignees.some((a) => a !== userId) && !(access.type === "organization" && isManager(access))) {
          throw forbidden("Only managers and admins can assign tasks to other people");
        }
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
        await addAssignees(db, id, input.workspaceId, assignees, userId);
        await log(db, input.workspaceId, userId, id, "task.created", { title: input.title });
        const others = assignees.filter((a) => a !== userId);
        if (others.length) {
          const names = new Map<string, string>(
            (await db.query(`select id, full_name from profiles where id = any($1::uuid[])`, [others])).rows.map((p) => [p.id, p.full_name]),
          );
          for (const u of others) await log(db, input.workspaceId, userId, id, "task.assigned", { userId: u, name: names.get(u) ?? "Someone" });
          toNotify = { userIds: others, by: await nameOf(db, userId), title: input.title };
        }
        if (dueAt) await applyDefaultReminders(db, { id, workspaceId: input.workspaceId }, userId);
        return loadItem(db, id);
      });
      if (toNotify) {
        const n = toNotify as { userIds: string[]; by: string; title: string };
        await notify({ userIds: n.userIds, workspaceId: input.workspaceId, taskId: id, type: "assigned", title: `${n.by} assigned you a task`, body: n.title }, ctx.log);
      }
      res.status(201).json(task);
    }),
  );

  r.get(
    "/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      res.json(await withUser(uid(req), (db) => loadDetail(db, id, uid(req))));
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

        // What actually changes (the edit form sends every field, so compare values, not keys).
        const changed: string[] = [];
        const differs = (name: string, next: unknown, prev: unknown) => {
          if (JSON.stringify(next ?? null) !== JSON.stringify(prev ?? null)) changed.push(name);
        };
        differs("title", m.title, cur.title);
        differs("description", m.description, cur.description);
        differs("notes", m.notes, cur.notes);
        differs("priority", m.priority, cur.priority);
        differs("status", m.status, cur.status);
        differs("project", m.projectId, cur.project_id);
        differs("category", m.categoryId, cur.category_id);
        differs("start date", m.startDate, cur.sd);
        differs("start time", m.startTime, cur.st);
        differs("due date", m.dueDate, cur.dd);
        differs("due time", m.dueTime, cur.dt);
        differs("estimate", m.estimatedMinutes, cur.estimated_minutes);
        differs("time spent", m.actualMinutes, cur.actual_minutes);
        differs("tags", m.tags, cur.tags);
        if ("recurrence" in input && (input.recurrence || cur.recurring_rule_id)) changed.push("repeat");

        const mine = await taskContext(db, id, uid(req));
        if (!mine.can.edit && changed.some((f) => !["status", "notes", "time spent"].includes(f))) {
          throw forbidden(REASSIGN_HINT);
        }

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
        const edited = changed.filter((f) => f !== "status");
        if (edited.length) await log(db, cur.workspace_id, uid(req), id, "task.updated", { fields: edited });
        if (changed.includes("status")) await log(db, cur.workspace_id, uid(req), id, "task.status_changed", { status: m.status, from: cur.status });
        if (["completed", "cancelled"].includes(m.status) && !["completed", "cancelled"].includes(cur.status)) {
          await spawnNextOccurrence(db, id, uid(req));
        }
        return loadDetail(db, id, uid(req));
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
          if (!(await taskContext(db, id, uid(req))).can.edit) throw forbidden(REASSIGN_HINT);
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
        const t = await taskContext(db, id, uid(req));
        // The delete policy limits plain members to tasks they created.
        const del = await db.query(`delete from tasks where id = $1`, [id]);
        if (del.rowCount === 0) throw forbidden("Only the creator, a manager or an admin can delete this task");
        await log(db, t.workspaceId, uid(req), id, "task.deleted", { title: t.title });
      });
      res.json({ ok: true });
    }),
  );

  // ---- Assignees (managers and admins) ----

  r.put(
    "/:id/assignees",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const { userIds } = parse(setAssigneesSchema, req.body);
      const me = uid(req);
      const want = [...new Set(userIds)];
      let added: string[] = [];
      let removed: string[] = [];
      let by = "";
      let taskTitle = "";
      let workspaceId = "";
      const detail = await withUser(me, async (db) => {
        const c = await taskContext(db, id, me);
        if (!c.can.assign) throw forbidden("Only managers and admins can assign tasks to people");
        const have = (await db.query(`select user_id from task_assignees where task_id = $1`, [id])).rows.map((x) => x.user_id as string);
        added = want.filter((u) => !have.includes(u));
        removed = have.filter((u) => !want.includes(u));
        await addAssignees(db, id, c.workspaceId, added, me);
        if (removed.length) await db.query(`delete from task_assignees where task_id = $1 and user_id = any($2::uuid[])`, [id, removed]);
        const names = new Map<string, string>(
          (await db.query(`select id, full_name from profiles where id = any($1::uuid[])`, [[...added, ...removed]])).rows.map((p) => [p.id, p.full_name]),
        );
        for (const u of added) await log(db, c.workspaceId, me, id, "task.assigned", { userId: u, name: names.get(u) ?? "Someone" });
        for (const u of removed) await log(db, c.workspaceId, me, id, "task.unassigned", { userId: u, name: names.get(u) ?? "Someone" });
        by = await nameOf(db, me);
        taskTitle = c.title;
        workspaceId = c.workspaceId;
        return loadDetail(db, id, me);
      });
      await dropRemindersFor(id, removed, ctx.log);
      await notify(
        { userIds: added.filter((u) => u !== me), workspaceId, taskId: id, type: "assigned", title: `${by} assigned you a task`, body: taskTitle },
        ctx.log,
      );
      res.json(detail);
    }),
  );

  // ---- Comments ----

  const commentOut = (row: Record<string, any>, me: string, admin: boolean): TaskComment => ({
    id: row.id,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    editedAt: row.edited_at ? new Date(row.edited_at).toISOString() : null,
    author: row.author_id ? { userId: row.author_id, fullName: row.full_name ?? "Former member", avatarUrl: avatarUrl(row.author_id, row.avatar_path) } : null,
    canEdit: row.author_id === me,
    canDelete: row.author_id === me || admin,
  });
  const COMMENT_SQL = `select c.id, c.body, c.created_at, c.edited_at, c.author_id, p.full_name, p.avatar_path
    from task_comments c left join profiles p on p.id = c.author_id`;

  r.get(
    "/:id/comments",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const me = uid(req);
      const out = await withUser(me, async (db) => {
        const c = await taskContext(db, id, me);
        const rows = await db.query(`${COMMENT_SQL} where c.task_id = $1 order by c.created_at, c.id`, [id]);
        return rows.rows.map((row) => commentOut(row, me, c.access.role === "admin"));
      });
      res.json(out);
    }),
  );

  r.post(
    "/:id/comments",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const { body } = parse(commentSchema, req.body);
      const me = uid(req);
      let recipients: string[] = [];
      let by = "";
      let ctxInfo: { workspaceId: string; title: string } | null = null;
      const comment = await withUser(me, async (db) => {
        const c = await taskContext(db, id, me);
        const ins = await db.query(
          `insert into task_comments (task_id, workspace_id, author_id, body) values ($1, $2, $3, $4) returning id`,
          [id, c.workspaceId, me, body],
        );
        await log(db, c.workspaceId, me, id, "task.commented");
        // The people with a stake in the task hear about it: whoever was assigned, and its creator.
        const who = await db.query(`select user_id from task_assignees where task_id = $1`, [id]);
        recipients = [...who.rows.map((x) => x.user_id as string), ...(c.createdBy ? [c.createdBy] : [])].filter((u) => u !== me);
        by = await nameOf(db, me);
        ctxInfo = { workspaceId: c.workspaceId, title: c.title };
        const row = await db.query(`${COMMENT_SQL} where c.id = $1`, [ins.rows[0].id]);
        return commentOut(row.rows[0], me, c.access.role === "admin");
      });
      const info = ctxInfo as { workspaceId: string; title: string } | null;
      if (info) {
        await notify(
          { userIds: recipients, workspaceId: info.workspaceId, taskId: id, type: "comment", title: `${by} commented on "${info.title}"`, body: body.slice(0, 200) },
          ctx.log,
        );
      }
      res.status(201).json(comment);
    }),
  );

  r.patch(
    "/:id/comments/:commentId",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const commentId = parse(uuidSchema, req.params.commentId);
      const { body } = parse(commentSchema, req.body);
      const me = uid(req);
      const out = await withUser(me, async (db) => {
        const c = await taskContext(db, id, me);
        const upd = await db.query(
          `update task_comments set body = $3, edited_at = now() where id = $2 and task_id = $1 and author_id = $4 returning id`,
          [id, commentId, body, me],
        );
        if (upd.rowCount === 0) {
          const exists = await db.query(`select 1 from task_comments where id = $1 and task_id = $2`, [commentId, id]);
          throw exists.rowCount ? forbidden("You can only edit your own comments") : notFound("Comment not found");
        }
        const row = await db.query(`${COMMENT_SQL} where c.id = $1`, [commentId]);
        return commentOut(row.rows[0], me, c.access.role === "admin");
      });
      res.json(out);
    }),
  );

  r.delete(
    "/:id/comments/:commentId",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const commentId = parse(uuidSchema, req.params.commentId);
      await withUser(uid(req), async (db) => {
        await taskContext(db, id, uid(req));
        const del = await db.query(`delete from task_comments where id = $1 and task_id = $2`, [commentId, id]);
        if (del.rowCount === 0) {
          const exists = await db.query(`select 1 from task_comments where id = $1 and task_id = $2`, [commentId, id]);
          throw exists.rowCount ? forbidden("Only the author or an admin can delete this comment") : notFound("Comment not found");
        }
      });
      res.json({ ok: true });
    }),
  );

  // ---- History of one task ----

  r.get(
    "/:id/activity",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const out = await withUser(uid(req), async (db) => {
        await taskContext(db, id, uid(req));
        const q = await db.query(
          `${ACTIVITY_SQL} where a.entity_type = 'task' and a.entity_id = $1 order by a.created_at desc, a.id limit 100`,
          [id],
        );
        return q.rows.map(mapActivity) satisfies ActivityEntry[];
      });
      res.json(out);
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
