-- When someone leaves or is removed from a workspace, drop their task assignments and pending
-- reminders there. Runs with definer rights because the leaving user cannot touch those rows
-- under RLS once their membership is gone (and plain members never could).

create function app.cleanup_removed_member() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  delete from task_assignees where workspace_id = old.workspace_id and user_id = old.user_id;
  delete from task_reminders
    where workspace_id = old.workspace_id and user_id = old.user_id and status in ('pending', 'processing');
  return old;
end
$$;

create trigger workspace_members_cleanup after delete on workspace_members
  for each row execute function app.cleanup_removed_member();

-- A member may assign themselves to a task they can already see (e.g. one they just created).
-- Assigning other people stays limited to admins and managers by task_assignees_write.
create policy assignees_self_insert on task_assignees for insert to lifesync_app
  with check (
    user_id = app.current_user_id() and assigned_by = app.current_user_id()
    and app.can_see_task(workspace_id, task_id)
  );
