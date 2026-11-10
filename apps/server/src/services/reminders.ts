import { randomUUID } from "node:crypto";
import {
  addDays,
  localDate,
  nextOccurrence,
  zonedToUtc,
  type Recurrence,
  type SetRemindersInput,
  type TaskReminder,
} from "@lifesync/shared";
import type { Db } from "../db/pool";

const MINUTE = 60_000;

/**
 * Replaces the caller's pending reminders on a task. Reminders already sent stay as history.
 * Times in the past are skipped (a reminder "1 hour before" a task due in 10 minutes makes no sense).
 * Must run inside withUser: row-level security scopes this to the caller's own reminders.
 */
export async function replaceReminders(
  db: Db,
  task: { id: string; workspaceId: string },
  userId: string,
  input: SetRemindersInput,
): Promise<{ created: number; skipped: number }> {
  const t = await db.query(`select due_at from tasks where id = $1`, [task.id]);
  const dueAt: Date | null = t.rows[0]?.due_at ?? null;
  await db.query(`delete from task_reminders where task_id = $1 and user_id = $2 and status = 'pending'`, [task.id, userId]);

  const now = Date.now();
  const wanted: { offset: number | null; at: Date }[] = [];
  for (const o of new Set(input.offsets)) {
    if (dueAt) wanted.push({ offset: o, at: new Date(dueAt.getTime() - o * MINUTE) });
  }
  for (const c of input.custom) wanted.push({ offset: null, at: new Date(c) });

  let created = 0;
  for (const w of wanted) {
    if (w.at.getTime() < now - MINUTE) continue;
    const ins = await db.query(
      `insert into task_reminders (id, task_id, workspace_id, user_id, offset_minutes, remind_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (task_id, user_id, remind_at) where status in ('pending', 'processing') do nothing`,
      [randomUUID(), task.id, task.workspaceId, userId, w.offset, w.at],
    );
    created += ins.rowCount ?? 0;
  }
  return { created, skipped: wanted.length - created };
}

/** Applies the user's default reminder offsets to a freshly created task that has a due time. */
export async function applyDefaultReminders(db: Db, task: { id: string; workspaceId: string }, userId: string) {
  const p = await db.query(`select default_reminder_offsets from user_notification_preferences where user_id = $1`, [userId]);
  const offsets: number[] = p.rows[0]?.default_reminder_offsets ?? [];
  if (offsets.length) await replaceReminders(db, task, userId, { offsets, custom: [] });
}

export async function listTaskReminders(db: Db, taskId: string, userId: string): Promise<TaskReminder[]> {
  const q = await db.query(
    `select id, offset_minutes, remind_at, status from task_reminders
     where task_id = $1 and user_id = $2 and status in ('pending', 'processing', 'sent')
     order by remind_at`,
    [taskId, userId],
  );
  return q.rows.map((r) => ({
    id: r.id,
    offsetMinutes: r.offset_minutes,
    remindAt: new Date(r.remind_at).toISOString(),
    status: r.status,
  }));
}

export function mapRule(r: Record<string, any>): Recurrence {
  return {
    frequency: r.frequency,
    interval: r.interval_n,
    byWeekday: r.by_weekday ?? [],
    byMonthday: r.by_monthday,
    endsOn: r.ends_on,
    maxCount: r.max_count,
  };
}

/** Creates the rule for a task, or updates the one it already has. Returns the rule id. */
export async function saveRule(
  db: Db,
  workspaceId: string,
  existingRuleId: string | null,
  rule: Recurrence,
  startsOn: string,
): Promise<string> {
  const values = [
    rule.frequency,
    rule.interval,
    rule.frequency === "weekly" && rule.byWeekday.length ? rule.byWeekday : null,
    rule.frequency === "monthly" ? rule.byMonthday : null,
    startsOn,
    rule.endsOn,
    rule.maxCount,
  ];
  if (existingRuleId) {
    await db.query(
      `update recurring_rules set frequency=$2, interval_n=$3, by_weekday=$4, by_monthday=$5, starts_on=$6, ends_on=$7, max_count=$8
       where id = $1`,
      [existingRuleId, ...values],
    );
    return existingRuleId;
  }
  const id = randomUUID();
  await db.query(
    `insert into recurring_rules (id, workspace_id, frequency, interval_n, by_weekday, by_monthday, starts_on, ends_on, max_count)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, workspaceId, ...values],
  );
  return id;
}

/**
 * When a repeating task is finished (completed or cancelled), creates its next occurrence.
 * Occurrences that are already in the past are skipped, so finishing a daily task three days late
 * produces tomorrow's task, not three overdue ones. Safe to call repeatedly: it does nothing if the
 * next occurrence already exists. Returns the new task id, if one was created.
 */
export async function spawnNextOccurrence(db: Db, taskId: string, userId: string): Promise<string | null> {
  const q = await db.query(
    `select t.*, t.due_date::text as dd, t.start_date::text as sd, to_char(t.due_time, 'HH24:MI') as dt,
            r.frequency, r.interval_n, r.by_weekday, r.by_monthday, r.starts_on::text as starts_on,
            r.ends_on::text as ends_on, r.max_count
     from tasks t join recurring_rules r on r.workspace_id = t.workspace_id and r.id = t.recurring_rule_id
     where t.id = $1 and t.status in ('completed', 'cancelled') and t.archived_at is null`,
    [taskId],
  );
  const t = q.rows[0];
  if (!t || !t.dd) return null;

  const child = await db.query(`select 1 from tasks where parent_task_id = $1`, [taskId]);
  if (child.rowCount) return null;
  if (t.max_count) {
    const used = await db.query(`select count(*)::int as n from tasks where recurring_rule_id = $1`, [t.recurring_rule_id]);
    if (used.rows[0].n >= t.max_count) return null;
  }

  const tz = (await db.query(`select timezone from profiles where id = $1`, [userId])).rows[0].timezone as string;
  const rule = mapRule(t);
  const today = localDate(Date.now(), tz);
  let next = nextOccurrence(rule, t.starts_on, t.dd);
  for (let i = 0; next && next < today && i < 1000; i++) next = nextOccurrence(rule, t.starts_on, next);
  if (!next) return null;

  const shift = Math.round((Date.parse(next) - Date.parse(t.dd)) / 86_400_000);
  const startDate = t.sd ? addDays(t.sd, shift) : null;
  const dueAt = t.dt ? zonedToUtc(next, t.dt, tz) : null;
  const id = randomUUID();
  await db.query(
    `insert into tasks (id, workspace_id, project_id, category_id, recurring_rule_id, parent_task_id, title, description, notes,
       priority, status, start_date, start_time, due_date, due_time, due_at, estimated_minutes, tags, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'todo',$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      id, t.workspace_id, t.project_id, t.category_id, t.recurring_rule_id, taskId, t.title, t.description, t.notes,
      t.priority, startDate, t.start_time, next, t.due_time, dueAt, t.estimated_minutes, t.tags, userId,
    ],
  );
  await db.query(
    `insert into subtasks (task_id, workspace_id, title, sort_order)
     select $2, workspace_id, title, sort_order from subtasks where task_id = $1`,
    [taskId, id],
  );
  await db.query(`insert into task_assignees (task_id, workspace_id, user_id, assigned_by) values ($1, $2, $3, $3)`, [id, t.workspace_id, userId]);
  // The same offsets the person had on the finished occurrence apply to the next one.
  const offs = await db.query(
    `select distinct offset_minutes from task_reminders where task_id = $1 and user_id = $2 and offset_minutes is not null`,
    [taskId, userId],
  );
  if (offs.rows.length) {
    await replaceReminders(db, { id, workspaceId: t.workspace_id }, userId, {
      offsets: offs.rows.map((o) => o.offset_minutes),
      custom: [],
    });
  }
  await db.query(
    `insert into activity_logs (workspace_id, actor_id, entity_type, entity_id, action, metadata)
     values ($1, $2, 'task', $3, 'task.recurred', jsonb_build_object('from', $4::text))`,
    [t.workspace_id, userId, id, taskId],
  );
  return id;
}
