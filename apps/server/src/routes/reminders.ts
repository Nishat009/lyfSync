import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  addDays,
  calendarQuerySchema,
  pushSubscribeSchema,
  setRemindersSchema,
  uuidSchema,
  zonedToUtc,
  type CalendarData,
  type CalendarItem,
  type PushStatus,
  type UpcomingReminder,
} from "@lifesync/shared";
import { requireAuth, uid } from "../auth/sessions";
import type { AppContext } from "../context";
import { withSystem, withUser, type Db } from "../db/pool";
import { badRequest, handler, notFound, parse } from "../http";
import { listTaskReminders, replaceReminders } from "../services/reminders";
import { PRIORITY_ORDER_SQL, TASK_LIST_FROM, TASK_LIST_SQL, mapListItem } from "../services/tasks";

const REMINDER_JOIN = `
  from task_reminders r
  join tasks t on t.workspace_id = r.workspace_id and t.id = r.task_id
  join workspaces w on w.id = r.workspace_id`;

function mapReminder(r: Record<string, any>): UpcomingReminder {
  return {
    id: r.id,
    taskId: r.task_id,
    taskTitle: r.title,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    workspaceType: r.workspace_type,
    remindAt: new Date(r.remind_at).toISOString(),
    offsetMinutes: r.offset_minutes,
  };
}

async function requireVisibleTask(db: Db, taskId: string): Promise<{ workspaceId: string }> {
  const t = await db.query(`select workspace_id from tasks where id = $1`, [taskId]);
  if (!t.rows[0]) throw notFound("Task not found");
  return { workspaceId: t.rows[0].workspace_id };
}

export function remindersRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth);

  // ---- Reminders on a task (always the caller's own) ----

  r.get(
    "/tasks/:id/reminders",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      res.json(
        await withUser(uid(req), async (db) => {
          await requireVisibleTask(db, id);
          return listTaskReminders(db, id, uid(req));
        }),
      );
    }),
  );

  r.put(
    "/tasks/:id/reminders",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const input = parse(setRemindersSchema, req.body);
      const out = await withUser(uid(req), async (db) => {
        const { workspaceId } = await requireVisibleTask(db, id);
        const result = await replaceReminders(db, { id, workspaceId }, uid(req), input);
        return { ...result, reminders: await listTaskReminders(db, id, uid(req)) };
      });
      res.json(out);
    }),
  );

  r.get(
    "/reminders/upcoming",
    handler(async (req, res) => {
      const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }), req.query);
      const list = await withUser(uid(req), async (db) => {
        const q = await db.query(
          `select r.id, r.task_id, r.workspace_id, r.remind_at, r.offset_minutes, t.title,
                  w.name as workspace_name, w.type as workspace_type
           ${REMINDER_JOIN}
           where r.status = 'pending' and r.remind_at >= now() - interval '1 minute'
             and t.status in ('todo', 'in_progress') and t.archived_at is null
           order by r.remind_at limit $1`,
          [limit],
        );
        return q.rows.map(mapReminder);
      });
      res.json(list);
    }),
  );

  // ---- Browser push ----

  r.get(
    "/push/status",
    handler(async (req, res) => {
      const n = await withUser(uid(req), async (db) => (await db.query(`select count(*)::int as n from push_subscriptions`)).rows[0].n as number);
      const body: PushStatus = { configured: ctx.push.configured, publicKey: ctx.push.publicKey, subscriptions: n };
      res.json(body);
    }),
  );

  r.post(
    "/push/subscribe",
    handler(async (req, res) => {
      const sub = parse(pushSubscribeSchema, req.body);
      if (!ctx.push.configured) throw badRequest("Push notifications are not set up on this server", "push_disabled");
      // A browser endpoint that used to belong to someone else (shared computer) moves to whoever
      // subscribes now; row-level security hides the old owner's row, so this one step is done as system.
      await withSystem((db) => db.query(`delete from push_subscriptions where endpoint = $1 and user_id <> $2`, [sub.endpoint, uid(req)]));
      await withUser(uid(req), (db) =>
        db.query(
          `insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
             user_agent = excluded.user_agent, failure_count = 0`,
          [randomUUID(), uid(req), sub.endpoint, sub.keys.p256dh, sub.keys.auth, req.get("user-agent")?.slice(0, 512) ?? null],
        ),
      );
      res.status(201).json({ ok: true });
    }),
  );

  r.delete(
    "/push/subscribe",
    handler(async (req, res) => {
      const { endpoint } = parse(z.object({ endpoint: z.string().max(2048) }), req.body);
      await withUser(uid(req), (db) => db.query(`delete from push_subscriptions where endpoint = $1`, [endpoint]));
      res.json({ ok: true });
    }),
  );

  // Sends a real push to this person's own devices so they can check that notifications arrive.
  r.post(
    "/push/test",
    handler(async (req, res) => {
      if (!ctx.push.configured) throw badRequest("Push notifications are not set up on this server", "push_disabled");
      const userId = uid(req);
      const subs = await withUser(userId, async (db) => (await db.query(`select id, endpoint, p256dh, auth from push_subscriptions`)).rows);
      if (!subs.length) throw badRequest("Turn on notifications for this device first", "no_subscription");
      const notificationId = randomUUID();
      await withSystem((db) =>
        db.query(
          `insert into notifications (id, user_id, type, title, body, link) values ($1, $2, 'test', 'Test notification', 'If you can read this, reminders will reach you here.', '/settings')`,
          [notificationId, userId],
        ),
      );
      let sent = 0;
      let failed = 0;
      for (const s of subs) {
        const out = await ctx.push.send(
          { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth },
          { title: "Test notification", body: "If you can read this, reminders will reach you here.", url: "/settings", notificationId, tag: "test" },
        );
        if (out.ok) sent++;
        else {
          failed++;
          if (out.gone) await withUser(userId, (db) => db.query(`delete from push_subscriptions where id = $1`, [s.id]));
        }
      }
      res.json({ sent, failed });
    }),
  );

  // ---- Calendar ----

  r.get(
    "/calendar",
    handler(async (req, res) => {
      const q = parse(calendarQuerySchema, req.query);
      if (q.to < q.from) throw badRequest("The end date is before the start date");
      if (addDays(q.from, 100) < q.to) throw badRequest("Choose a range of at most 100 days");
      const userId = uid(req);
      const data = await withUser(userId, async (db) => {
        const tz = (await db.query(`select timezone from profiles where id = $1`, [userId])).rows[0].timezone as string;
        const ws = q.workspaceId ?? null;
        // Same scope rule as My Day: one workspace, or all personal tasks plus org tasks assigned to me.
        const scope = `(
          ($1::uuid is null and (w.type = 'personal'
            or exists (select 1 from task_assignees a where a.task_id = t.id and a.user_id = app.current_user_id())))
          or t.workspace_id = $1)`;
        const items = await db.query(
          `select ${TASK_LIST_SQL}, t.start_date::text as start_date, to_char(t.start_time, 'HH24:MI') as start_time
           ${TASK_LIST_FROM}
           where t.archived_at is null and t.status <> 'cancelled' and t.due_date between $2::date and $3::date and ${scope}
           order by t.due_date, t.due_time nulls first, ${PRIORITY_ORDER_SQL}
           limit 1000`,
          [ws, q.from, q.to],
        );
        const rem = await db.query(
          `select r.id, r.task_id, r.workspace_id, r.remind_at, r.offset_minutes, t.title,
                  w.name as workspace_name, w.type as workspace_type
           ${REMINDER_JOIN}
           where r.status = 'pending' and r.remind_at >= $2 and r.remind_at < $3
             and t.status in ('todo', 'in_progress') and t.archived_at is null and ($1::uuid is null or r.workspace_id = $1)
           order by r.remind_at limit 500`,
          [ws, zonedToUtc(q.from, "00:00", tz), zonedToUtc(addDays(q.to, 1), "00:00", tz)],
        );
        const body: CalendarData = {
          from: q.from,
          to: q.to,
          timezone: tz,
          items: items.rows.map((row): CalendarItem => ({ ...mapListItem(row), startDate: row.start_date, startTime: row.start_time })),
          reminders: rem.rows.map(mapReminder),
        };
        return body;
      });
      res.json(data);
    }),
  );

  return r;
}
