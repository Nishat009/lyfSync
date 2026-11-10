-- Row-level security.
--
-- Model: the API opens a transaction, runs SET LOCAL ROLE lifesync_app and sets app.user_id.
-- From then on every statement is filtered by the policies below, whatever the application code
-- asks for. System transactions (login, registration, scheduler) run as the owner and are the only
-- code that can touch users, sessions, auth_tokens and notifications inserts.
--
-- Personal-workspace privacy: a personal workspace has exactly one member (its owner), enforced by
-- a trigger. Every policy grants access through membership, and organization roles only exist in
-- organization workspaces, so no organization admin or manager can ever see personal data.

-- ---------------------------------------------------------------------------
-- Helper functions. SECURITY DEFINER so they can read workspace_members without recursing into
-- its own policies. They only ever answer questions about app.current_user_id().
-- ---------------------------------------------------------------------------

create function app.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from workspace_members
    where workspace_id = ws and user_id = app.current_user_id()
  )
$$;

create function app.has_role(ws uuid, roles workspace_role[]) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from workspace_members
    where workspace_id = ws and user_id = app.current_user_id() and role = any (roles)
  )
$$;

-- True for the person who created an organization that has no members yet (the bootstrap step of
-- creating an organization). Needed because RLS hides the workspace until its creator is a member.
create function app.is_bootstrapping_creator(ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from workspaces w
    where w.id = ws and w.type = 'organization' and w.created_by = app.current_user_id()
  ) and not exists (select 1 from workspace_members where workspace_id = ws)
$$;

create function app.shares_workspace_with(other uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from workspace_members a
    join workspace_members b on b.workspace_id = a.workspace_id
    where a.user_id = app.current_user_id() and b.user_id = other
  )
$$;

-- Members see everything in an organization workspace except that plain members only see tasks
-- they created or are assigned to. Admins and managers see all tasks.
create function app.can_see_task(ws uuid, tid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from workspace_members m
    where m.workspace_id = ws and m.user_id = app.current_user_id()
      and (
        m.role in ('admin', 'manager')
        or exists (select 1 from tasks t where t.id = tid and t.created_by = m.user_id)
        or exists (select 1 from task_assignees a where a.task_id = tid and a.user_id = m.user_id)
      )
  )
$$;

-- ---------------------------------------------------------------------------
-- Grants. users, sessions and auth_tokens are intentionally absent.
-- ---------------------------------------------------------------------------

grant usage on schema public, app to lifesync_app;
grant execute on all functions in schema app to lifesync_app;

grant select, update on profiles to lifesync_app;
grant select, insert, update, delete on
  user_notification_preferences, push_subscriptions, workspaces, workspace_members,
  workspace_invitations, categories, projects, recurring_rules, tasks, task_assignees, subtasks,
  task_comments, task_attachments, task_reminders, habits, habit_logs, focus_sessions, notes
  to lifesync_app;
grant select, update, delete on notifications to lifesync_app;
grant select on notification_deliveries to lifesync_app;
grant select, insert on activity_logs to lifesync_app;

alter table profiles enable row level security;
alter table user_notification_preferences enable row level security;
alter table push_subscriptions enable row level security;
alter table workspaces enable row level security;
alter table workspace_members enable row level security;
alter table workspace_invitations enable row level security;
alter table categories enable row level security;
alter table projects enable row level security;
alter table recurring_rules enable row level security;
alter table tasks enable row level security;
alter table task_assignees enable row level security;
alter table subtasks enable row level security;
alter table task_comments enable row level security;
alter table task_attachments enable row level security;
alter table task_reminders enable row level security;
alter table notifications enable row level security;
alter table notification_deliveries enable row level security;
alter table habits enable row level security;
alter table habit_logs enable row level security;
alter table focus_sessions enable row level security;
alter table notes enable row level security;
alter table activity_logs enable row level security;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- Profiles: your own, plus people you share a workspace with (member lists, assignee pickers).
create policy profiles_select on profiles for select to lifesync_app
  using (id = app.current_user_id() or app.shares_workspace_with(id));
create policy profiles_update on profiles for update to lifesync_app
  using (id = app.current_user_id()) with check (id = app.current_user_id());

create policy prefs_all on user_notification_preferences for all to lifesync_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

create policy push_all on push_subscriptions for all to lifesync_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

-- Workspaces. Personal workspaces are created by the registration system transaction.
create policy workspaces_select on workspaces for select to lifesync_app
  using (app.is_member(id));
create policy workspaces_insert on workspaces for insert to lifesync_app
  with check (type = 'organization' and created_by = app.current_user_id());
create policy workspaces_update on workspaces for update to lifesync_app
  using (app.has_role(id, array['admin']::workspace_role[]))
  with check (app.has_role(id, array['admin']::workspace_role[]));
create policy workspaces_delete on workspaces for delete to lifesync_app
  using (type = 'organization' and app.has_role(id, array['admin']::workspace_role[]));

-- Membership. The creator bootstraps an empty organization as its first admin. Everything else
-- (accepting an invitation) goes through a system transaction after the token is verified.
create policy members_select on workspace_members for select to lifesync_app
  using (app.is_member(workspace_id));
create policy members_insert on workspace_members for insert to lifesync_app
  with check (
    app.has_role(workspace_id, array['admin']::workspace_role[])
    or (user_id = app.current_user_id() and role = 'admin' and app.is_bootstrapping_creator(workspace_id))
  );
create policy members_update on workspace_members for update to lifesync_app
  using (app.has_role(workspace_id, array['admin']::workspace_role[]))
  with check (app.has_role(workspace_id, array['admin']::workspace_role[]));
create policy members_delete on workspace_members for delete to lifesync_app
  using (app.has_role(workspace_id, array['admin']::workspace_role[]) or user_id = app.current_user_id());

create policy invitations_all on workspace_invitations for all to lifesync_app
  using (app.has_role(workspace_id, array['admin']::workspace_role[]))
  with check (app.has_role(workspace_id, array['admin']::workspace_role[]));

-- Categories, projects, recurring rules: readable by members, managed by admins and managers.
create policy categories_select on categories for select to lifesync_app using (app.is_member(workspace_id));
create policy categories_write on categories for all to lifesync_app
  using (app.has_role(workspace_id, array['admin', 'manager']::workspace_role[]))
  with check (app.has_role(workspace_id, array['admin', 'manager']::workspace_role[]));

create policy projects_select on projects for select to lifesync_app using (app.is_member(workspace_id));
create policy projects_write on projects for all to lifesync_app
  using (app.has_role(workspace_id, array['admin', 'manager']::workspace_role[]))
  with check (app.has_role(workspace_id, array['admin', 'manager']::workspace_role[]));

create policy rules_select on recurring_rules for select to lifesync_app using (app.is_member(workspace_id));
create policy rules_write on recurring_rules for all to lifesync_app
  using (app.has_role(workspace_id, array['admin', 'manager']::workspace_role[]))
  with check (app.has_role(workspace_id, array['admin', 'manager']::workspace_role[]));

-- Tasks. Admins and managers manage everything. Members see and update tasks they created or are
-- assigned to, and may create tasks for themselves. (Which columns a member may change is
-- enforced by the API; RLS decides which rows.)
create policy tasks_select on tasks for select to lifesync_app using (app.can_see_task(workspace_id, id));
create policy tasks_insert on tasks for insert to lifesync_app
  with check (app.is_member(workspace_id) and created_by = app.current_user_id());
create policy tasks_update on tasks for update to lifesync_app
  using (app.can_see_task(workspace_id, id)) with check (app.is_member(workspace_id));
create policy tasks_delete on tasks for delete to lifesync_app
  using (
    app.has_role(workspace_id, array['admin', 'manager']::workspace_role[])
    or (created_by = app.current_user_id() and app.is_member(workspace_id))
  );

create policy assignees_select on task_assignees for select to lifesync_app
  using (app.can_see_task(workspace_id, task_id));
create policy assignees_write on task_assignees for all to lifesync_app
  using (app.has_role(workspace_id, array['admin', 'manager']::workspace_role[]))
  with check (app.has_role(workspace_id, array['admin', 'manager']::workspace_role[]));

create policy subtasks_all on subtasks for all to lifesync_app
  using (app.can_see_task(workspace_id, task_id)) with check (app.can_see_task(workspace_id, task_id));

create policy comments_select on task_comments for select to lifesync_app
  using (app.can_see_task(workspace_id, task_id));
create policy comments_insert on task_comments for insert to lifesync_app
  with check (author_id = app.current_user_id() and app.can_see_task(workspace_id, task_id));
create policy comments_update on task_comments for update to lifesync_app
  using (author_id = app.current_user_id()) with check (author_id = app.current_user_id());
create policy comments_delete on task_comments for delete to lifesync_app
  using (author_id = app.current_user_id() or app.has_role(workspace_id, array['admin']::workspace_role[]));

create policy attachments_select on task_attachments for select to lifesync_app
  using (app.can_see_task(workspace_id, task_id));
create policy attachments_insert on task_attachments for insert to lifesync_app
  with check (uploaded_by = app.current_user_id() and app.can_see_task(workspace_id, task_id));
create policy attachments_delete on task_attachments for delete to lifesync_app
  using (uploaded_by = app.current_user_id() or app.has_role(workspace_id, array['admin', 'manager']::workspace_role[]));

-- Reminders belong to one user and only for tasks that user can see.
create policy reminders_all on task_reminders for all to lifesync_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id() and app.can_see_task(workspace_id, task_id));

-- Notifications are created by the scheduler/system; users read, mark read, and delete their own.
create policy notifications_select on notifications for select to lifesync_app
  using (user_id = app.current_user_id());
create policy notifications_update on notifications for update to lifesync_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy notifications_delete on notifications for delete to lifesync_app
  using (user_id = app.current_user_id());

create policy deliveries_select on notification_deliveries for select to lifesync_app
  using (user_id = app.current_user_id());

create policy habits_all on habits for all to lifesync_app
  using (user_id = app.current_user_id() and app.is_member(workspace_id))
  with check (user_id = app.current_user_id() and app.is_member(workspace_id));
create policy habit_logs_all on habit_logs for all to lifesync_app
  using (user_id = app.current_user_id() and app.is_member(workspace_id))
  with check (user_id = app.current_user_id() and app.is_member(workspace_id));

create policy focus_all on focus_sessions for all to lifesync_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id() and (workspace_id is null or app.is_member(workspace_id)));

-- Notes: private notes are visible to their author only, workspace notes to every member.
create policy notes_select on notes for select to lifesync_app
  using (app.is_member(workspace_id) and (author_id = app.current_user_id() or visibility = 'workspace'));
create policy notes_insert on notes for insert to lifesync_app
  with check (app.is_member(workspace_id) and author_id = app.current_user_id());
create policy notes_update on notes for update to lifesync_app
  using (author_id = app.current_user_id() and app.is_member(workspace_id))
  with check (author_id = app.current_user_id() and app.is_member(workspace_id));
create policy notes_delete on notes for delete to lifesync_app
  using (author_id = app.current_user_id());

-- Activity timeline: admins and managers read it, any member appends entries as themselves.
create policy activity_select on activity_logs for select to lifesync_app
  using (app.has_role(workspace_id, array['admin', 'manager']::workspace_role[]));
create policy activity_insert on activity_logs for insert to lifesync_app
  with check (app.is_member(workspace_id) and actor_id = app.current_user_id());
