-- LifeSync foundation: extensions, the restricted application role, enums and shared helpers.
-- Requires PostgreSQL 15 or newer (ON DELETE SET NULL (column) is used in later migrations).

create extension if not exists citext;

-- The API connects as the database owner and switches to this role (SET LOCAL ROLE) inside every
-- request transaction. The role has no BYPASSRLS, so row-level security applies to every query
-- the API runs on behalf of a user. See docs/ARCHITECTURE.md, "Authorization".
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lifesync_app') then
    create role lifesync_app nologin noinherit;
  end if;
end
$$;

grant lifesync_app to current_user;

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type workspace_type as enum ('personal', 'organization');
create type workspace_role as enum ('admin', 'manager', 'member');
create type invitation_status as enum ('pending', 'accepted', 'revoked', 'declined', 'expired');
create type project_status as enum ('active', 'on_hold', 'completed', 'archived');
create type task_priority as enum ('urgent', 'high', 'medium', 'low');
create type task_status as enum ('todo', 'in_progress', 'completed', 'cancelled');
create type reminder_status as enum ('pending', 'processing', 'sent', 'failed', 'cancelled');
create type notification_channel as enum ('in_app', 'push', 'email');
create type delivery_status as enum ('pending', 'sent', 'failed', 'skipped');
create type recurrence_frequency as enum ('daily', 'weekly', 'monthly', 'yearly');
create type focus_kind as enum ('focus', 'short_break', 'long_break');
create type note_kind as enum ('quick', 'task', 'meeting', 'personal');
create type note_visibility as enum ('private', 'workspace');
create type auth_token_kind as enum ('password_reset', 'email_verification');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The user the current transaction acts for. Set by the API with
-- set_config('app.user_id', <uuid>, true). Null in system (owner) transactions.
create function app.current_user_id() returns uuid
language sql stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create function app.set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;
