import { randomUUID } from "node:crypto";
import { localDate, localTime, zonedToUtc, addDays } from "@lifesync/shared";
import type { Config } from "../config";
import { withSystem, type Db } from "../db/pool";
import type { Mailer } from "./mailer";
import type { PushSender } from "./push";

/**
 * Reminder scheduler. It runs in the API process on a timer, but all of its state lives in the
 * database, so it survives restarts and several instances can run at once without double-sending:
 *
 *  - due reminders are claimed with FOR UPDATE SKIP LOCKED and a lease (crashes are recovered);
 *  - each reminder becomes at most one notification (reminder_id + unique delivery per channel);
 *  - every channel has its own delivery row with attempts, backoff and a final status.
 *
 * It uses withSystem (no row-level security) because it acts across users; every query is
 * scoped by ids it read itself.
 */

export interface SchedulerDeps {
  config: Config;
  mailer: Mailer;
  push: PushSender;
  log: (msg: string, err?: unknown) => void;
}

const MAX_ATTEMPTS = 5;
const LEASE = "5 minutes";
const STALE_MS = 12 * 3_600_000;

export interface TickResult {
  reminders: number;
  deliveries: number;
  missed: number;
}

interface Prefs {
  in_app_enabled: boolean;
  push_enabled: boolean;
  email_enabled: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string;
}

/** The instant quiet hours end, or null when they are not in effect right now. */
export function quietHoursEnd(p: Prefs, now: Date): Date | null {
  if (!p.quiet_hours_enabled || !p.quiet_hours_start || !p.quiet_hours_end) return null;
  const start = p.quiet_hours_start.slice(0, 5);
  const end = p.quiet_hours_end.slice(0, 5);
  const here = localTime(now, p.timezone);
  const wraps = start > end;
  const inside = wraps ? here >= start || here < end : here >= start && here < end;
  if (!inside) return null;
  const today = localDate(now, p.timezone);
  const endsToday = wraps ? here < end : true;
  return zonedToUtc(endsToday ? today : addDays(today, 1), end, p.timezone);
}

function dueText(r: { due_at: Date | null; dd: string | null; dt: string | null }, now: Date): string {
  if (r.due_at) {
    const mins = Math.round((r.due_at.getTime() - now.getTime()) / 60_000);
    const clock = r.dt ? ` (${formatClock(r.dt)})` : "";
    if (mins <= 0) return `Due now${clock}`;
    if (mins < 60) return `Due in ${mins} minute${mins === 1 ? "" : "s"}${clock}`;
    if (mins < 1440) {
      const h = Math.round(mins / 60);
      return `Due in ${h} hour${h === 1 ? "" : "s"}${clock}`;
    }
    return `Due ${r.dd}${clock}`;
  }
  return r.dd ? `Due ${r.dd}` : "Reminder";
}

function formatClock(time: string): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/** Creates the per-channel delivery rows for a notification. In-app is delivered the moment the row exists. */
async function createDeliveries(db: Db, notificationId: string, userId: string, now: Date): Promise<void> {
  const q = await db.query(
    `select p.in_app_enabled, p.push_enabled, p.email_enabled, p.quiet_hours_enabled, p.quiet_hours_start::text,
            p.quiet_hours_end::text, pr.timezone,
            exists (select 1 from push_subscriptions s where s.user_id = p.user_id) as has_push
     from user_notification_preferences p join profiles pr on pr.id = p.user_id where p.user_id = $1`,
    [userId],
  );
  const p = q.rows[0];
  if (!p) return;
  const hold = quietHoursEnd(p, now);
  const add = (channel: string, status: string, next: Date | null) =>
    db.query(
      `insert into notification_deliveries (id, notification_id, user_id, channel, status, next_attempt_at, delivered_at)
       values ($1, $2, $3, $4::notification_channel, $5::delivery_status, $6::timestamptz, case when $5::delivery_status = 'sent' then $7::timestamptz end)
       on conflict (notification_id, channel) do nothing`,
      [randomUUID(), notificationId, userId, channel, status, next, now],
    );
  if (p.in_app_enabled) await add("in_app", "sent", null);
  if (p.push_enabled && p.has_push) await add("push", "pending", hold);
  if (p.email_enabled) await add("email", "pending", hold);
}

async function fireReminder(db: Db, reminderId: string, now: Date): Promise<boolean> {
  const q = await db.query(
    `select r.id, r.user_id, r.task_id, r.remind_at, t.title, t.status, t.archived_at, t.workspace_id, t.due_at,
            t.due_date::text as dd, to_char(t.due_time, 'HH24:MI') as dt, p.in_app_enabled
     from task_reminders r
     join tasks t on t.workspace_id = r.workspace_id and t.id = r.task_id
     join user_notification_preferences p on p.user_id = r.user_id
     where r.id = $1 and r.status = 'processing'
     for update of r`,
    [reminderId],
  );
  const r = q.rows[0];
  if (!r) return false;
  // Finished, cancelled or archived tasks no longer need a nudge.
  if (r.archived_at || !["todo", "in_progress"].includes(r.status)) {
    await db.query(`update task_reminders set status = 'cancelled', locked_at = null where id = $1`, [reminderId]);
    return false;
  }
  // After long downtime, do not replay old reminders; the missed-task alert covers anything still open.
  if (now.getTime() - new Date(r.remind_at).getTime() > STALE_MS) {
    await db.query(`update task_reminders set status = 'cancelled', locked_at = null, last_error = 'expired before it could be sent' where id = $1`, [reminderId]);
    return false;
  }
  const notificationId = randomUUID();
  await db.query(
    `insert into notifications (id, user_id, workspace_id, reminder_id, task_id, type, title, body, link, read_at, created_at)
     values ($1, $2, $3, $4, $5, 'reminder', $6, $7, $8, case when $9 then null else $10::timestamptz end, $10)`,
    [notificationId, r.user_id, r.workspace_id, r.id, r.task_id, r.title.slice(0, 200), dueText(r, now), `/my-day?task=${r.task_id}`, r.in_app_enabled, now],
  );
  await createDeliveries(db, notificationId, r.user_id, now);
  await db.query(`update task_reminders set status = 'sent', sent_at = $2, locked_at = null, last_error = null where id = $1`, [reminderId, now]);
  return true;
}

async function runReminders(deps: SchedulerDeps, now: Date): Promise<number> {
  const claimed = await withSystem(async (db) => {
    const q = await db.query(
      `update task_reminders r set status = 'processing', locked_at = $1::timestamptz, attempts = attempts + 1
       where r.id in (
         select id from task_reminders
         where (status = 'pending' and remind_at <= $1::timestamptz and (next_attempt_at is null or next_attempt_at <= $1::timestamptz))
            or (status = 'processing' and locked_at < $1::timestamptz - interval '${LEASE}')
         order by remind_at limit 50 for update skip locked)
       returning r.id, r.attempts`,
      [now],
    );
    return q.rows as { id: string; attempts: number }[];
  });

  let fired = 0;
  for (const c of claimed) {
    try {
      if (await withSystem((db) => fireReminder(db, c.id, now))) fired++;
    } catch (e) {
      deps.log(`reminder ${c.id} failed (attempt ${c.attempts})`, e);
      const message = e instanceof Error ? e.message.slice(0, 300) : "unknown error";
      await withSystem((db) =>
        db.query(
          `update task_reminders set status = case when attempts >= $2 then 'failed'::reminder_status else 'pending'::reminder_status end,
             locked_at = null, last_error = $3, next_attempt_at = $4::timestamptz + (least(power(2, attempts), 60) || ' minutes')::interval
           where id = $1`,
          [c.id, MAX_ATTEMPTS, message, now],
        ),
      ).catch((err) => deps.log("could not record reminder failure", err));
    }
  }
  return fired;
}

type Outcome = { status: "sent" } | { status: "skipped"; reason: string } | { status: "retry"; error: string };

async function sendPush(deps: SchedulerDeps, db: Db, d: Record<string, any>): Promise<Outcome> {
  const subs = await db.query(`select id, endpoint, p256dh, auth, failure_count from push_subscriptions where user_id = $1`, [d.user_id]);
  if (!subs.rows.length) return { status: "skipped", reason: "no push subscription" };
  if (!deps.push.configured) return { status: "skipped", reason: "push is not configured on the server" };
  let ok = false;
  let lastError = "";
  let transient = false;
  for (const s of subs.rows) {
    const res = await deps.push.send(
      { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth },
      { title: d.title, body: d.body ?? "", url: d.link ?? "/my-day", notificationId: d.notification_id, tag: `task-${d.task_id ?? d.notification_id}` },
    );
    if (res.ok) {
      ok = true;
      await db.query(`update push_subscriptions set last_success_at = now(), failure_count = 0 where id = $1`, [s.id]);
    } else if (res.gone) {
      await db.query(`delete from push_subscriptions where id = $1`, [s.id]);
    } else {
      transient = true;
      lastError = res.error;
      await db.query(`update push_subscriptions set failure_count = failure_count + 1 where id = $1`, [s.id]);
      await db.query(`delete from push_subscriptions where id = $1 and failure_count >= 10`, [s.id]);
    }
  }
  if (ok) return { status: "sent" };
  return transient ? { status: "retry", error: lastError } : { status: "skipped", reason: "subscription is no longer valid" };
}

async function sendEmail(deps: SchedulerDeps, d: Record<string, any>): Promise<Outcome> {
  if (!d.email_verified_at) return { status: "skipped", reason: "email address is not confirmed" };
  try {
    const sent = await deps.mailer.send({
      to: d.email,
      subject: d.title,
      text: `${d.body ?? ""}\n\nOpen LifeSync: ${deps.config.APP_URL}${d.link ?? "/my-day"}\n\nYou can change reminder emails in Settings > Notifications.`,
    });
    return sent ? { status: "sent" } : { status: "skipped", reason: "SMTP is not configured" };
  } catch (e) {
    return { status: "retry", error: e instanceof Error ? e.message.slice(0, 300) : "email failed" };
  }
}

async function runDeliveries(deps: SchedulerDeps, now: Date): Promise<number> {
  // Claim with a lease: the row stays pending, but is invisible to other runs for a few minutes.
  const claimed = await withSystem(async (db) => {
    const q = await db.query(
      `update notification_deliveries d set attempts = attempts + 1, next_attempt_at = $1::timestamptz + interval '${LEASE}'
       where d.id in (
         select id from notification_deliveries
         where status = 'pending' and channel <> 'in_app' and coalesce(next_attempt_at, created_at) <= $1::timestamptz
         order by created_at limit 100 for update skip locked)
       returning d.id, d.attempts`,
      [now],
    );
    return q.rows as { id: string; attempts: number }[];
  });

  let done = 0;
  for (const c of claimed) {
    try {
      await withSystem(async (db) => {
        const q = await db.query(
          `select d.id, d.channel, d.user_id, d.notification_id, n.title, n.body, n.link, n.task_id, u.email, u.email_verified_at
           from notification_deliveries d join notifications n on n.id = d.notification_id join users u on u.id = d.user_id
           where d.id = $1`,
          [c.id],
        );
        const d = q.rows[0];
        if (!d) return;
        const outcome = d.channel === "push" ? await sendPush(deps, db, d) : await sendEmail(deps, d);
        if (outcome.status === "sent") {
          await db.query(`update notification_deliveries set status = 'sent', delivered_at = $2, last_error = null, next_attempt_at = null where id = $1`, [c.id, now]);
          done++;
        } else if (outcome.status === "skipped") {
          await db.query(`update notification_deliveries set status = 'skipped', last_error = $2, next_attempt_at = null where id = $1`, [c.id, outcome.reason]);
        } else if (c.attempts >= MAX_ATTEMPTS) {
          await db.query(`update notification_deliveries set status = 'failed', last_error = $2, next_attempt_at = null where id = $1`, [c.id, outcome.error]);
        } else {
          // 2, 4, 8, 16 minutes between attempts
          await db.query(
            `update notification_deliveries set last_error = $2, next_attempt_at = $3::timestamptz + (power(2, $4::int) || ' minutes')::interval where id = $1`,
            [c.id, outcome.error, now, c.attempts],
          );
        }
      });
    } catch (e) {
      deps.log(`delivery ${c.id} crashed`, e);
    }
  }
  return done;
}

/** "You missed it" alerts: an open timed task that is 15+ minutes overdue, once per task and person. */
async function runMissed(deps: SchedulerDeps, now: Date): Promise<number> {
  return withSystem(async (db) => {
    const q = await db.query(
      `insert into notifications (user_id, workspace_id, task_id, type, title, body, link, created_at)
       select a.user_id, t.workspace_id, t.id, 'missed', left('Missed: ' || t.title, 200),
              'Due ' || t.due_date::text || ' at ' || to_char(t.due_time, 'HH12:MI AM') || '. Finish it or move it to a new time.',
              '/my-day?task=' || t.id, $1
       from tasks t
       join task_assignees a on a.task_id = t.id
       join user_notification_preferences p on p.user_id = a.user_id
       where t.status in ('todo', 'in_progress') and t.archived_at is null and t.due_at is not null
         and t.due_at < $1::timestamptz - interval '15 minutes' and t.due_at > $1::timestamptz - interval '2 days'
         and p.missed_reminder_alerts
       limit 200
       on conflict (user_id, task_id) where type = 'missed' do nothing
       returning id, user_id`,
      [now],
    );
    for (const n of q.rows) await createDeliveries(db, n.id, n.user_id, now);
    return q.rowCount ?? 0;
  });
}

/** One scheduler pass. Exported so tests (and an operator) can drive time explicitly. */
export async function runSchedulerOnce(deps: SchedulerDeps, now: Date = new Date()): Promise<TickResult> {
  const reminders = await runReminders(deps, now);
  const missed = await runMissed(deps, now);
  const deliveries = await runDeliveries(deps, now);
  return { reminders, deliveries, missed };
}

export function startScheduler(deps: SchedulerDeps): () => void {
  const every = deps.config.SCHEDULER_INTERVAL_SECONDS * 1000;
  if (every <= 0) {
    deps.log("reminder scheduler is disabled (SCHEDULER_INTERVAL_SECONDS=0)");
    return () => {};
  }
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap with a slow previous pass
    running = true;
    try {
      const r = await runSchedulerOnce(deps);
      if (r.reminders || r.deliveries || r.missed) deps.log(`scheduler: ${r.reminders} reminders, ${r.deliveries} deliveries, ${r.missed} missed alerts`);
    } catch (e) {
      deps.log("scheduler pass failed", e);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, every);
  void tick(); // catch up immediately after a restart
  deps.log(`reminder scheduler running every ${deps.config.SCHEDULER_INTERVAL_SECONDS}s`);
  return () => clearInterval(timer);
}
