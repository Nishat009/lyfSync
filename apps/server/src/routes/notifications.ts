import { Router } from "express";
import { z } from "zod";
import type { NotificationPage } from "@lifesync/shared";
import { snoozeSchema, uuidSchema } from "@lifesync/shared";
import { requireAuth, uid } from "../auth/sessions";
import type { AppContext } from "../context";
import { withUser } from "../db/pool";
import { badRequest, handler, notFound, parse } from "../http";
import { spawnNextOccurrence } from "../services/reminders";

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.iso.datetime().optional(),
  unread: z.enum(["true", "false"]).optional(),
});

/** Adds one extra pending reminder at `when` without touching the person's other reminders. */
async function replaceRemindersKeep(db: import("../db/pool").Db, taskId: string, workspaceId: string, userId: string, when: Date): Promise<Date> {
  await db.query(
    `insert into task_reminders (task_id, workspace_id, user_id, offset_minutes, remind_at)
     values ($1, $2, $3, null, $4)
     on conflict (task_id, user_id, remind_at) where status in ('pending', 'processing') do nothing`,
    [taskId, workspaceId, userId, when],
  );
  return when;
}

export function notificationsRouter(_ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    "/",
    handler(async (req, res) => {
      const q = parse(pageSchema, req.query);
      const page = await withUser(uid(req), async (db) => {
        const rows = await db.query(
          `select id, type, title, body, link, task_id, read_at, created_at from notifications
           where ($1::timestamptz is null or created_at < $1)
             and ($2::boolean is not true or read_at is null)
           order by created_at desc limit $3`,
          [q.before ?? null, q.unread === "true", q.limit + 1],
        );
        const items = rows.rows.slice(0, q.limit).map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          link: n.link,
          taskId: n.task_id,
          readAt: n.read_at ? n.read_at.toISOString() : null,
          createdAt: n.created_at.toISOString(),
        }));
        const out: NotificationPage = {
          items,
          nextCursor: rows.rows.length > q.limit ? items[items.length - 1]!.createdAt : null,
        };
        return out;
      });
      res.json(page);
    }),
  );

  r.post(
    "/read-all",
    handler(async (req, res) => {
      await withUser(uid(req), (db) => db.query(`update notifications set read_at = now() where read_at is null`));
      res.json({ ok: true });
    }),
  );

  r.post(
    "/:id/read",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const n = await withUser(uid(req), (db) =>
        db.query(`update notifications set read_at = coalesce(read_at, now()) where id = $1`, [id]),
      );
      if (n.rowCount === 0) throw notFound();
      res.json({ ok: true });
    }),
  );

  // Snooze: remind me about the same task again in N minutes (works from the notification itself).
  r.post(
    "/:id/snooze",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const { minutes } = parse(snoozeSchema, req.body);
      const at = await withUser(uid(req), async (db) => {
        const n = await db.query(`select task_id, workspace_id from notifications where id = $1`, [id]);
        if (!n.rows[0]) throw notFound();
        if (!n.rows[0].task_id) throw badRequest("This notification is not about a task", "not_a_task");
        const when = new Date(Date.now() + minutes * 60_000);
        const result = await replaceRemindersKeep(db, n.rows[0].task_id, n.rows[0].workspace_id, uid(req), when);
        await db.query(`update notifications set read_at = coalesce(read_at, now()) where id = $1`, [id]);
        return result;
      });
      res.json({ remindAt: at.toISOString() });
    }),
  );

  // Complete the task a notification is about, straight from the notification.
  r.post(
    "/:id/complete",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      await withUser(uid(req), async (db) => {
        const n = await db.query(`select task_id from notifications where id = $1`, [id]);
        if (!n.rows[0]) throw notFound();
        const taskId = n.rows[0].task_id;
        if (!taskId) throw badRequest("This notification is not about a task", "not_a_task");
        const upd = await db.query(
          `update tasks set status = 'completed', completed_at = coalesce(completed_at, now()) where id = $1 returning workspace_id`,
          [taskId],
        );
        if (upd.rowCount === 0) throw notFound("Task not found");
        await db.query(
          `insert into activity_logs (workspace_id, actor_id, entity_type, entity_id, action, metadata)
           values ($1, $2, 'task', $3, 'task.status_changed', jsonb_build_object('status', 'completed', 'via', 'notification'))`,
          [upd.rows[0].workspace_id, uid(req), taskId],
        );
        await spawnNextOccurrence(db, taskId, uid(req));
        await db.query(`update notifications set read_at = coalesce(read_at, now()) where id = $1`, [id]);
      });
      res.json({ ok: true });
    }),
  );

  r.delete(
    "/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      await withUser(uid(req), (db) => db.query(`delete from notifications where id = $1`, [id]));
      res.json({ ok: true });
    }),
  );

  return r;
}
