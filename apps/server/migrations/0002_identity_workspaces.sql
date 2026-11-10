-- Identity (users, profiles, sessions, one-time tokens) and workspaces.

-- ---------------------------------------------------------------------------
-- Identity. users, sessions and auth_tokens are never granted to lifesync_app:
-- only the API's system transactions (auth flows) can read them.
-- ---------------------------------------------------------------------------

create table users (
  id                 uuid primary key default gen_random_uuid(),
  email              citext not null unique check (char_length(email) <= 254),
  password_hash      text,                        -- null for Google-only accounts
  google_sub         text unique,
  email_verified_at  timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (password_hash is not null or google_sub is not null)
);
create trigger users_updated_at before update on users
  for each row execute function app.set_updated_at();

create table profiles (
  id             uuid primary key references users (id) on delete cascade,
  email          citext not null,                 -- copy of users.email, kept in sync by trigger
  full_name      text not null check (char_length(full_name) between 1 and 120),
  avatar_path    text,
  timezone       text not null default 'Asia/Dhaka' check (char_length(timezone) between 1 and 64),
  week_starts_on smallint not null default 6 check (week_starts_on between 0 and 6), -- 0 = Sunday
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger profiles_updated_at before update on profiles
  for each row execute function app.set_updated_at();

create function app.sync_profile_email() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update profiles set email = new.email where id = new.id;
  return new;
end
$$;
create trigger users_sync_profile_email after update of email on users
  for each row when (old.email is distinct from new.email)
  execute function app.sync_profile_email();

create table sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  token_hash   text not null unique,              -- sha256 of the cookie value, hex
  user_agent   text check (char_length(user_agent) <= 512),
  ip           inet,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);

create table auth_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  kind        auth_token_kind not null,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index auth_tokens_user_kind_idx on auth_tokens (user_id, kind);

create table user_notification_preferences (
  user_id                  uuid primary key references users (id) on delete cascade,
  in_app_enabled           boolean not null default true,
  push_enabled             boolean not null default true,
  email_enabled            boolean not null default false,
  default_reminder_offsets integer[] not null default '{15}',
  missed_reminder_alerts   boolean not null default true,
  quiet_hours_enabled      boolean not null default false,
  quiet_hours_start        time,
  quiet_hours_end          time,
  updated_at               timestamptz not null default now(),
  check (not quiet_hours_enabled or (quiet_hours_start is not null and quiet_hours_end is not null))
);
create trigger user_notification_preferences_updated_at before update on user_notification_preferences
  for each row execute function app.set_updated_at();

create table push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users (id) on delete cascade,
  endpoint        text not null unique check (char_length(endpoint) <= 2048),
  p256dh          text not null,
  auth            text not null,
  user_agent      text check (char_length(user_agent) <= 512),
  failure_count   smallint not null default 0,
  last_success_at timestamptz,
  created_at      timestamptz not null default now()
);
create index push_subscriptions_user_id_idx on push_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- Workspaces
-- ---------------------------------------------------------------------------

create table workspaces (
  id          uuid primary key default gen_random_uuid(),
  type        workspace_type not null,
  name        text not null check (char_length(name) between 1 and 80),
  description text check (char_length(description) <= 500),
  -- Set only for personal workspaces: the one person who can ever access it.
  owner_id    uuid references users (id) on delete cascade,
  created_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check ((type = 'personal') = (owner_id is not null))
);
create unique index workspaces_one_personal_per_user on workspaces (owner_id) where type = 'personal';
create trigger workspaces_updated_at before update on workspaces
  for each row execute function app.set_updated_at();

create function app.guard_workspace_update() returns trigger
language plpgsql
as $$
begin
  if new.type is distinct from old.type or new.owner_id is distinct from old.owner_id then
    raise exception 'workspace type and owner cannot change' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger workspaces_guard_update before update on workspaces
  for each row execute function app.guard_workspace_update();

create table workspace_members (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  user_id      uuid not null references users (id) on delete cascade,
  role         workspace_role not null default 'member',
  joined_at    timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index workspace_members_user_id_idx on workspace_members (user_id);

-- Personal workspaces have exactly one member, their owner, with the admin role.
-- Organizations must always keep at least one admin.
create function app.guard_workspace_members() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  ws workspaces%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into ws from workspaces where id = new.workspace_id;
    if ws.type = 'personal' and (new.user_id <> ws.owner_id or new.role <> 'admin') then
      raise exception 'personal workspaces cannot have other members' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  select * into ws from workspaces where id = old.workspace_id;
  if not found then
    return coalesce(new, old); -- the workspace itself is being deleted
  end if;

  if tg_op = 'UPDATE' then
    if new.workspace_id <> old.workspace_id or new.user_id <> old.user_id then
      raise exception 'membership workspace and user cannot change' using errcode = 'check_violation';
    end if;
    if ws.type = 'personal' and new.role <> old.role then
      raise exception 'personal workspace roles cannot change' using errcode = 'check_violation';
    end if;
    if old.role = 'admin' and new.role <> 'admin' and not exists (
      select 1 from workspace_members
      where workspace_id = old.workspace_id and role = 'admin' and id <> old.id
    ) then
      raise exception 'an organization needs at least one admin' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- DELETE. When the owner's account is being deleted, the users row is already gone and the
  -- personal workspace is about to be removed by the same cascade.
  if ws.type = 'personal' then
    if exists (select 1 from users where id = ws.owner_id) then
      raise exception 'personal workspace membership cannot be removed' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.role = 'admin' and not exists (
    select 1 from workspace_members
    where workspace_id = old.workspace_id and role = 'admin' and id <> old.id
  ) then
    raise exception 'an organization needs at least one admin' using errcode = 'check_violation';
  end if;
  return old;
end
$$;
create trigger workspace_members_guard
  before insert or update or delete on workspace_members
  for each row execute function app.guard_workspace_members();

create table workspace_invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  email        citext not null check (char_length(email) <= 254),
  role         workspace_role not null default 'member',
  token_hash   text not null unique,
  status       invitation_status not null default 'pending',
  invited_by   uuid references users (id) on delete set null,
  accepted_by  uuid references users (id) on delete set null,
  expires_at   timestamptz not null,
  responded_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index workspace_invitations_one_pending
  on workspace_invitations (workspace_id, email) where status = 'pending';
create index workspace_invitations_email_idx on workspace_invitations (email) where status = 'pending';
create trigger workspace_invitations_updated_at before update on workspace_invitations
  for each row execute function app.set_updated_at();

create function app.guard_workspace_invitations() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if (select type from workspaces where id = new.workspace_id) <> 'organization' then
    raise exception 'only organizations accept invitations' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger workspace_invitations_guard before insert on workspace_invitations
  for each row execute function app.guard_workspace_invitations();
