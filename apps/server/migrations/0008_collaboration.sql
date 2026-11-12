-- Phase 4: organization collaboration.
--
-- Members need to read the history of the tasks they can see (not the whole workspace feed, which
-- stays limited to admins and managers), and the per-task history query needs an index.

create policy activity_task_select on activity_logs for select to lifesync_app
  using (entity_type = 'task' and entity_id is not null and app.can_see_task(workspace_id, entity_id));

create index activity_logs_entity_idx on activity_logs (entity_id, created_at desc) where entity_id is not null;

-- Assignee lookups by workspace and person (team workload, "assigned to me" filters).
create index task_assignees_workspace_user_idx on task_assignees (workspace_id, user_id);
