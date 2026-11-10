-- Phase 3: reliable reminders and recurring tasks.

-- Notifications can point at the task they are about. The partial unique index makes the
-- "missed reminder" alert fire at most once per task and person, even if two scheduler
-- processes run at the same time.
alter table notifications add column task_id uuid references tasks (id) on delete cascade;
create index notifications_task_idx on notifications (task_id);
create unique index notifications_missed_once on notifications (user_id, task_id) where type = 'missed';

-- When a task's due time changes, every pending offset-based reminder ("15 minutes before") moves
-- with it. Reminders whose new time is already past are cancelled rather than fired late. Runs with
-- definer rights because the person editing the task is not necessarily the reminder's owner.
create function app.reschedule_task_reminders() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.due_at is not distinct from old.due_at then
    return new;
  end if;
  if new.due_at is null then
    update task_reminders set status = 'cancelled'
    where task_id = new.id and status = 'pending' and offset_minutes is not null;
    return new;
  end if;
  -- Two steps so the "no duplicate pending reminder" index cannot trip over rows that are
  -- temporarily moving onto each other's old times.
  update task_reminders set remind_at = remind_at + interval '100 years'
  where task_id = new.id and status = 'pending' and offset_minutes is not null;
  update task_reminders
  set remind_at = new.due_at - make_interval(mins => offset_minutes),
      status = case when new.due_at - make_interval(mins => offset_minutes) < now() - interval '1 minute'
                    then 'cancelled'::reminder_status else 'pending'::reminder_status end
  where task_id = new.id and status = 'pending' and offset_minutes is not null;
  return new;
end
$$;

create trigger tasks_reschedule_reminders after update of due_at on tasks
  for each row execute function app.reschedule_task_reminders();

-- Any member may create a recurrence rule for a task they work on, and change or remove a rule
-- that one of their visible tasks uses. Admins and managers keep full control (rules_write).
create policy rules_member_insert on recurring_rules for insert to lifesync_app
  with check (app.is_member(workspace_id));
create policy rules_member_update on recurring_rules for update to lifesync_app
  using (exists (
    select 1 from tasks t
    where t.workspace_id = recurring_rules.workspace_id and t.recurring_rule_id = recurring_rules.id
      and app.can_see_task(t.workspace_id, t.id)
  ));
create policy rules_member_delete on recurring_rules for delete to lifesync_app
  using (exists (
    select 1 from tasks t
    where t.workspace_id = recurring_rules.workspace_id and t.recurring_rule_id = recurring_rules.id
      and app.can_see_task(t.workspace_id, t.id)
  ));

grant execute on function app.reschedule_task_reminders() to lifesync_app;
