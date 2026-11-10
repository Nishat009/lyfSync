import type { TaskDetail, TaskListItem, TaskSummary } from "@lifesync/shared";

/** Columns every task list needs, with dates as plain strings (the pg driver would make Dates). */
export const TASK_SUMMARY_SQL = `
  t.id, t.workspace_id, w.name as workspace_name, w.type as workspace_type, t.title, t.priority, t.status,
  t.due_date::text as due_date, to_char(t.due_time, 'HH24:MI') as due_time, t.due_at, t.completed_at,
  t.estimated_minutes, c.name as category_name, c.color as category_color`;

export const TASK_SUMMARY_FROM = `
  from tasks t
  join workspaces w on w.id = t.workspace_id
  left join categories c on c.workspace_id = t.workspace_id and c.id = t.category_id`;

export function mapTask(r: Record<string, any>): TaskSummary {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    workspaceType: r.workspace_type,
    title: r.title,
    priority: r.priority,
    status: r.status,
    dueDate: r.due_date,
    dueTime: r.due_time,
    dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    estimatedMinutes: r.estimated_minutes,
    categoryName: r.category_name,
    categoryColor: r.category_color,
  };
}

/** Orders urgent first, then by earliest time. */
export const PRIORITY_ORDER_SQL = `case t.priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;

/** Summary plus what the list and board views show: project, tags, checklist progress. */
export const TASK_LIST_SQL = `${TASK_SUMMARY_SQL},
  t.project_id, p.name as project_name, t.tags, (t.archived_at is not null) as archived, (t.recurring_rule_id is not null) as recurring,
  (select count(*)::int from subtasks s where s.task_id = t.id) as subtasks_total,
  (select count(*)::int from subtasks s where s.task_id = t.id and s.is_done) as subtasks_done`;

export const TASK_LIST_FROM = `${TASK_SUMMARY_FROM}
  left join projects p on p.workspace_id = t.workspace_id and p.id = t.project_id`;

export function mapListItem(r: Record<string, any>): TaskListItem {
  return {
    ...mapTask(r),
    projectId: r.project_id,
    projectName: r.project_name,
    tags: r.tags,
    subtasksDone: r.subtasks_done,
    subtasksTotal: r.subtasks_total,
    archived: r.archived,
    recurring: r.recurring,
  };
}

export const TASK_DETAIL_SQL = `${TASK_LIST_SQL},
  t.description, t.notes, t.category_id, t.start_date::text as start_date,
  to_char(t.start_time, 'HH24:MI') as start_time, t.actual_minutes, t.created_at,
  (select full_name from profiles where id = t.created_by) as created_by_name`;

export function mapDetail(
  r: Record<string, any>,
  subtasks: TaskDetail["subtasks"],
  assignees: TaskDetail["assignees"],
  recurrence: TaskDetail["recurrence"],
): TaskDetail {
  return {
    ...mapListItem(r),
    description: r.description,
    notes: r.notes,
    categoryId: r.category_id,
    startDate: r.start_date,
    startTime: r.start_time,
    actualMinutes: r.actual_minutes,
    createdAt: new Date(r.created_at).toISOString(),
    createdByName: r.created_by_name,
    assignees,
    subtasks,
    recurrence,
  };
}
