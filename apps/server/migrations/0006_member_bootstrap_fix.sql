-- Creating an organization failed on databases that applied an earlier draft of 0004: its
-- members_insert policy looked the workspace up directly, but row-level security hides a workspace
-- from its creator until they are a member, so the bootstrap insert was always rejected.
--
-- The final 0004 already contains this fix, so on a fresh database this migration changes nothing
-- of substance. It exists to bring databases migrated from the earlier draft in line.

create or replace function app.is_bootstrapping_creator(ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from workspaces w
    where w.id = ws and w.type = 'organization' and w.created_by = app.current_user_id()
  ) and not exists (select 1 from workspace_members where workspace_id = ws)
$$;

grant execute on function app.is_bootstrapping_creator(uuid) to lifesync_app;

drop policy if exists members_insert on workspace_members;
create policy members_insert on workspace_members for insert to lifesync_app
  with check (
    app.has_role(workspace_id, array['admin']::workspace_role[])
    or (user_id = app.current_user_id() and role = 'admin' and app.is_bootstrapping_creator(workspace_id))
  );

drop function if exists app.workspace_has_no_members(uuid);
