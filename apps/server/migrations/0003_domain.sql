-- Domain tables. Every workspace-owned table carries workspace_id so RLS can decide access with
-- one membership lookup. Composite foreign keys (workspace_id, id) stop a row from pointing at a
-- parent that lives in a different workspace.

create table categories (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 60),
  color        text not null default '#64748b' check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at   timestamptz not null default now(),
  unique (workspace_id, name),
  unique (workspace_id, id)
);

create table projects (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 120),
  description  text check (char_length(description) <= 2000),
  status       project_status not null default 'active',
  color        text not null default '#2563eb' check (color ~ '^#[0-9a-fA-F]{6}$'),
  due_date     date,
  created_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, id)
);
create index projects_workspace_idx on projects (workspace_id, status);
create trigger projects_updated_at before update on projects
  for each row execute function app.set_updated_at();

create table recurring_rules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  frequency    recurrence_frequency not null,
  interval_n   integer not null default 1 check (interval_n between 1 and 365),
  by_weekday   smallint[] check (by_weekday <@ array[0,1,2,3,4,5,6]::smallint[]), -- 0 = Sunday
  by_monthday  smallint check (by_monthday between 1 and 31),
  starts_on    date not null,
  ends_on      date,
  max_count    integer check (max_count > 0),
  created_at   timestamptz not null default now(),
  unique (workspace_id, id),
  check (ends_on is null or ends_on >= starts_on)
);

create table tasks (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces (id) on delete cascade,
  project_id        uuid,
  category_id       uuid,
  recurring_rule_id uuid,
  parent_task_id    uuid,                          -- the occurrence this task was generated from
  title             text not null check (char_length(title) between 1 and 300),
  description       text check (char_length(description) <= 10000),
  notes             text check (char_length(notes) <= 20000),
  priority          task_priority not null default 'medium',
  status            task_status not null default 'todo',
  start_date        date,
  due_date          date,
  start_time        time,
  due_time          time,
  -- Absolute due instant, computed by the API from due_date/due_time and the user's time zone.
  due_at            timestamptz,
  estimated_minutes integer check (estimated_minutes > 0),
  actual_minutes    integer not null default 0 check (actual_minutes >= 0),
  tags              text[] not null default '{}' check (cardinality(tags) <= 20),
  sort_order        double precision not null default 0,
  completed_at      timestamptz,
  archived_at       timestamptz,
  created_by        uuid references users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, project_id) references projects (workspace_id, id),
  foreign key (workspace_id, category_id) references categories (workspace_id, id),
  foreign key (workspace_id, recurring_rule_id) references recurring_rules (workspace_id, id),
  foreign key (workspace_id, parent_task_id) references tasks (workspace_id, id) on delete set null (parent_task_id),
  check (due_time is null or due_date is not null),
  check (start_time is null or start_date is not null),
  check (start_date is null or due_date is null or start_date <= due_date),
  check ((status = 'completed') = (completed_at is not null))
);
create index tasks_workspace_status_idx on tasks (workspace_id, status) where archived_at is null;
create index tasks_workspace_due_idx on tasks (workspace_id, due_date) where archived_at is null;
create index tasks_due_at_idx on tasks (due_at) where status in ('todo', 'in_progress');
create index tasks_project_idx on tasks (project_id);
create index tasks_tags_idx on tasks using gin (tags);
create index tasks_title_search_idx on tasks using gin (to_tsvector('simple', title || ' ' || coalesce(description, '')));
create trigger tasks_updated_at before update on tasks
  for each row execute function app.set_updated_at();

create table task_assignees (
  task_id      uuid not null,
  workspace_id uuid not null,
  user_id      uuid not null references users (id) on delete cascade,
  assigned_by  uuid references users (id) on delete set null,
  assigned_at  timestamptz not null default now(),
  primary key (task_id, user_id),
  foreign key (workspace_id, task_id) references tasks (workspace_id, id) on delete cascade
);
create index task_assignees_user_idx on task_assignees (user_id);

-- Assignees must belong to the task's workspace.
create function app.guard_task_assignee() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from workspace_members where workspace_id = new.workspace_id and user_id = new.user_id
  ) then
    raise exception 'assignee is not a member of this workspace' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger task_assignees_guard before insert or update on task_assignees
  for each row execute function app.guard_task_assignee();

create table subtasks (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null,
  workspace_id uuid not null,
  title        text not null check (char_length(title) between 1 and 300),
  is_done      boolean not null default false,
  sort_order   double precision not null default 0,
  created_at   timestamptz not null default now(),
  foreign key (workspace_id, task_id) references tasks (workspace_id, id) on delete cascade
);
create index subtasks_task_idx on subtasks (task_id);

create table task_comments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null,
  workspace_id uuid not null,
  author_id    uuid references users (id) on delete set null,
  body         text not null check (char_length(body) between 1 and 5000),
  created_at   timestamptz not null default now(),
  edited_at    timestamptz,
  foreign key (workspace_id, task_id) references tasks (workspace_id, id) on delete cascade
);
create index task_comments_task_idx on task_comments (task_id, created_at);

create table task_attachments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null,
  workspace_id uuid not null,
  uploaded_by  uuid references users (id) on delete set null,
  file_name    text not null check (char_length(file_name) <= 255),
  storage_path text not null,
  mime_type    text not null,
  size_bytes   bigint not null check (size_bytes between 0 and 26214400),
  created_at   timestamptz not null default now(),
  foreign key (workspace_id, task_id) references tasks (workspace_id, id) on delete cascade
);
create index task_attachments_task_idx on task_attachments (task_id);

-- One row per scheduled reminder. remind_at is an absolute instant, so the scheduler never needs
-- the user's time zone. The partial unique index below prevents duplicate reminders.
create table task_reminders (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null,
  workspace_id   uuid not null,
  user_id        uuid not null references users (id) on delete cascade,
  offset_minutes integer check (offset_minutes between 0 and 525600), -- null = custom time
  remind_at      timestamptz not null,
  status         reminder_status not null default 'pending',
  attempts       smallint not null default 0,
  next_attempt_at timestamptz,
  locked_at      timestamptz,
  snoozed_until  timestamptz,
  sent_at        timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  foreign key (workspace_id, task_id) references tasks (workspace_id, id) on delete cascade
);
create unique index task_reminders_no_duplicates
  on task_reminders (task_id, user_id, remind_at) where status in ('pending', 'processing');
create index task_reminders_due_idx on task_reminders (remind_at) where status = 'pending';
create index task_reminders_user_idx on task_reminders (user_id, status);

create table notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  workspace_id uuid references workspaces (id) on delete cascade,
  reminder_id  uuid references task_reminders (id) on delete set null,
  type         text not null check (char_length(type) <= 40),
  title        text not null check (char_length(title) <= 200),
  body         text check (char_length(body) <= 1000),
  link         text check (char_length(link) <= 500),
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, created_at desc);
create index notifications_unread_idx on notifications (user_id) where read_at is null;

-- Delivery log per channel. The unique key makes retries and duplicate scheduler runs idempotent.
create table notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications (id) on delete cascade,
  user_id         uuid not null references users (id) on delete cascade,
  channel         notification_channel not null,
  status          delivery_status not null default 'pending',
  attempts        smallint not null default 0,
  next_attempt_at timestamptz,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (notification_id, channel)
);
create index notification_deliveries_due_idx on notification_deliveries (next_attempt_at) where status = 'pending';

create table habits (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  user_id      uuid not null references users (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 120),
  description  text check (char_length(description) <= 500),
  by_weekday   smallint[] not null default '{0,1,2,3,4,5,6}',
  target_per_day smallint not null default 1 check (target_per_day between 1 and 100),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (workspace_id, id)
);
create index habits_user_idx on habits (user_id);

create table habit_logs (
  id           uuid primary key default gen_random_uuid(),
  habit_id     uuid not null,
  workspace_id uuid not null,
  user_id      uuid not null references users (id) on delete cascade,
  log_date     date not null,
  count        smallint not null default 1 check (count > 0),
  created_at   timestamptz not null default now(),
  unique (habit_id, log_date),
  foreign key (workspace_id, habit_id) references habits (workspace_id, id) on delete cascade
);

create table focus_sessions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid references workspaces (id) on delete cascade,
  user_id          uuid not null references users (id) on delete cascade,
  task_id          uuid references tasks (id) on delete set null,
  kind             focus_kind not null default 'focus',
  planned_minutes  integer not null check (planned_minutes between 1 and 240),
  actual_seconds   integer not null default 0 check (actual_seconds >= 0),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  completed        boolean not null default false
);
create index focus_sessions_user_idx on focus_sessions (user_id, started_at desc);

create table notes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  author_id    uuid not null references users (id) on delete cascade,
  task_id      uuid,
  kind         note_kind not null default 'quick',
  visibility   note_visibility not null default 'private',
  title        text check (char_length(title) <= 200),
  body         text not null default '' check (char_length(body) <= 50000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (workspace_id, task_id) references tasks (workspace_id, id) on delete set null (task_id)
);
create index notes_workspace_idx on notes (workspace_id, created_at desc);
create trigger notes_updated_at before update on notes
  for each row execute function app.set_updated_at();

create table activity_logs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  actor_id     uuid references users (id) on delete set null,
  entity_type  text not null check (char_length(entity_type) <= 40),
  entity_id    uuid,
  action       text not null check (char_length(action) <= 60),
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index activity_logs_workspace_idx on activity_logs (workspace_id, created_at desc);
