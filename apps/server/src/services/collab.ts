import { randomUUID } from "node:crypto";
import type { ActivityEntry, TaskPermissions, WorkspaceRole } from "@lifesync/shared";
import { withSystem, type Db } from "../db/pool";
import { createDeliveries } from "./scheduler";

export interface WorkspaceAccess {
  type: "personal" | "organization";
  role: WorkspaceRole;
}

/** The caller's role in a workspace. Must run inside withUser; null when they are not a member. */
export async function workspaceAccess(db: Db, workspaceId: string): Promise<WorkspaceAccess | null> {
  const q = await db.query(
    `select w.type, m.role from workspaces w
     join workspace_members m on m.workspace_id = w.id and m.user_id = app.current_user_id()
     where w.id = $1`,
    [workspaceId],
  );
  return q.rows[0] ? { type: q.rows[0].type, role: q.rows[0].role } : null;
}

export const isManager = (a: WorkspaceAccess) => a.role === "admin" || a.role === "manager";

/**
 * What a person may do with one task. This mirrors the database policies (which decide which rows
 * are visible and deletable) and adds the column-level rule RLS cannot express: somebody who was
 * only assigned a task can move it forward (status, notes, time spent, checklist) but not
 * reshape it. Creators, managers and admins can change everything.
 */
export function taskPermissions(a: WorkspaceAccess, createdBy: string | null, userId: string): TaskPermissions {
  const manager = a.type === "organization" && isManager(a);
  const creator = createdBy === userId;
  return {
    edit: a.type === "personal" || manager || creator,
    assign: manager,
    delete: a.type === "personal" || manager || creator,
  };
}

export interface Notice {
  userIds: string[];
  workspaceId: string;
  taskId: string;
  type: "assigned" | "comment";
  title: string;
  body: string;
}

/**
 * Tells people about something that happened on a task: an in-app notification, then push and
 * email through the same delivery pipeline the reminders use (preferences, quiet hours, retries).
 * Runs after the request's own transaction so a notification problem can never undo the action.
 */
export async function notify(n: Notice, log: (msg: string, err?: unknown) => void): Promise<void> {
  const people = [...new Set(n.userIds)];
  if (!people.length) return;
  try {
    await withSystem(async (db) => {
      const now = new Date();
      for (const userId of people) {
        // Only people who are still members of the workspace hear about its tasks.
        const ok = await db.query(
          `select p.in_app_enabled from workspace_members m
           join user_notification_preferences p on p.user_id = m.user_id
           where m.workspace_id = $1 and m.user_id = $2`,
          [n.workspaceId, userId],
        );
        if (!ok.rows[0]) continue;
        const id = randomUUID();
        await db.query(
          `insert into notifications (id, user_id, workspace_id, task_id, type, title, body, link, read_at, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, case when $9 then null else $10::timestamptz end, $10)`,
          [id, userId, n.workspaceId, n.taskId, n.type, n.title.slice(0, 200), n.body.slice(0, 500), `/my-day?task=${n.taskId}`, ok.rows[0].in_app_enabled, now],
        );
        await createDeliveries(db, id, userId, now);
      }
    });
  } catch (e) {
    log("could not send collaboration notifications", e);
  }
}

/**
 * Appends a line to the activity timeline. Must run inside withUser.
 *
 * created_at uses clock_timestamp(), not the column default now(): now() is frozen at the start of
 * the transaction, so two entries written by one request ("created" then "assigned") would share a
 * timestamp and show up in random order.
 */
export async function logActivity(
  db: Db,
  workspaceId: string,
  actor: string,
  entityType: string,
  entityId: string | null,
  action: string,
  metadata: object = {},
): Promise<void> {
  await db.query(
    `insert into activity_logs (workspace_id, actor_id, entity_type, entity_id, action, metadata, created_at)
     values ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
    [workspaceId, actor, entityType, entityId, action, JSON.stringify(metadata)],
  );
}

/**
 * A person who loses access to a task should stop receiving its reminders. This runs as the system
 * role because row-level security (rightly) stops a manager touching somebody else's reminders.
 * People who can still see the task regardless (its creator, managers, admins) keep theirs.
 */
export async function dropRemindersFor(taskId: string, userIds: string[], log: (msg: string, err?: unknown) => void): Promise<void> {
  if (!userIds.length) return;
  try {
    await withSystem((db) =>
      db.query(
        `update task_reminders r set status = 'cancelled', locked_at = null, last_error = 'no longer assigned'
         where r.task_id = $1 and r.user_id = any($2::uuid[]) and r.status in ('pending', 'processing')
           and not exists (select 1 from tasks t where t.id = r.task_id and t.created_by = r.user_id)
           and not exists (select 1 from workspace_members m where m.workspace_id = r.workspace_id and m.user_id = r.user_id and m.role in ('admin', 'manager'))`,
        [taskId, userIds],
      ),
    );
  } catch (e) {
    log("could not cancel reminders of unassigned people", e);
  }
}

export const ACTIVITY_SQL = `
  select a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at, a.actor_id, p.full_name as actor_name,
         coalesce(t.title, a.metadata->>'title') as task_title
  from activity_logs a
  left join profiles p on p.id = a.actor_id
  left join tasks t on a.entity_type = 'task' and t.id = a.entity_id`;

export function mapActivity(r: Record<string, any>): ActivityEntry {
  return {
    id: r.id,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    taskTitle: r.entity_type === "task" ? r.task_title : null,
    actor: r.actor_id ? { userId: r.actor_id, fullName: r.actor_name ?? "Former member" } : null,
    metadata: r.metadata ?? {},
    createdAt: new Date(r.created_at).toISOString(),
  };
}
