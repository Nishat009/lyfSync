# LifeSync architecture

This describes what is built today (Phases 1 to 3) and what is planned. It is kept next to the code so it can be corrected when the code changes.

## 1. System overview

```
Browser ──► Next.js web app (apps/web, :3000)
              │  /api/*  proxied by next.config.ts rewrites (same-origin, so the session cookie is first-party)
              ▼
            Express API (apps/server, :4000) ──► PostgreSQL (row-level security)
              ▲
         packages/shared: zod schemas, types and time helpers used by both sides
```

- **Web**: Next.js 16 (App Router, Cache Components), TypeScript, Tailwind CSS 4, Radix primitives, React Hook Form + Zod, Recharts, Lucide.
- **API**: Express 5, `pg`, Zod. One endpoint family per feature under `/api`.
- **Database**: PostgreSQL. The API is the only client; browsers never talk to the database.
- **Shared**: validation schemas are defined once in `packages/shared` and reused for form validation in the browser and request validation on the server.

### Deviation from the original brief

The brief proposed Supabase (Auth, Postgres, RLS, Realtime, Storage). The implementation uses an Express API with plain PostgreSQL instead. The security model the brief asked for is preserved: access control is enforced by Postgres row-level security, not only by application code (see section 4). Supabase-specific pieces map as follows:

| Brief | Current implementation |
| --- | --- |
| Supabase Auth | Own email/password + Google sign-in, hashed passwords, server-side sessions (`apps/server/src/auth`) |
| Supabase RLS | Native Postgres RLS with a restricted `lifesync_app` role |
| Supabase Storage | Local `STORAGE_DIR` for avatars (attachments not built yet) |
| Supabase Realtime | Not built; the UI refetches on focus and after mutations |

## 2. Folder structure

```
apps/
  server/
    migrations/        numbered SQL migrations (0001 … 0006), applied by `npm run db:migrate`
    scripts/local-db.ts  embedded PostgreSQL for development
    src/
      app.ts           Express wiring, security middleware
      auth/            password hashing, sessions, account creation
      db/              pool, `withUser` / `withSystem` transactions, migration runner
      routes/          auth, me, workspaces, invitations, tasks (+ checklists), projects (+ categories), dashboard, notifications
      services/        mailer, invitations, task queries
    tests/             privacy and role tests against a real database
  web/
    src/app/
      (auth)/          login, register, forgot/reset password, verify email
      (app)/           signed-in area: my-day, w/[id], w/[id]/tasks (list + board), w/[id]/projects, w/[id]/members,
                       settings, notifications, invitations, invite
    src/components/
      ui/              button, form controls, card, dialog/menu, avatar
      app/             app shell, sidebar, workspace switcher, quick add, notification centre, dashboard
    src/lib/           api client, `useQuery` hook, helpers
packages/shared/       schemas, types, constants, time helpers
docs/                  this file
```

## 3. Data model

Tables: `users`, `profiles`, `sessions`, `auth_tokens`, `user_notification_preferences`, `push_subscriptions`, `workspaces`, `workspace_members`, `workspace_invitations`, `categories`, `projects`, `recurring_rules`, `tasks`, `task_assignees`, `subtasks`, `task_comments`, `task_attachments`, `task_reminders`, `notifications`, `notification_deliveries`, `habits`, `habit_logs`, `focus_sessions`, `notes`, `activity_logs`.

Key relationships:

- `users` 1—1 `profiles`; a profile owns its notification preferences.
- `workspaces` (type `personal` or `organization`) ← `workspace_members` (role `admin` | `manager` | `member`) → `profiles`.
- Everything workspace-scoped (`tasks`, `projects`, `categories`, `notes`, `habits`, …) carries a `workspace_id`.
- `tasks` → `task_assignees`, `subtasks`, `task_comments`, `task_attachments`, `task_reminders`.
- `task_reminders` → `notification_deliveries` (one row per channel attempt, with status and retry data).
- All primary keys are UUIDs; foreign keys, check constraints, timestamps and indexes are in `apps/server/migrations/`.

The whole schema ships up front. So far the UI and API use identity, workspaces, invitations, notifications, tasks, subtasks, projects, categories and activity logs; the rest arrive in later phases.

## 4. Authentication and authorization

**Authentication**
- Registration creates the user, profile, default notification preferences and a **personal workspace** in one transaction.
- Sessions are random tokens stored hashed in `sessions`, sent in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production).
- State-changing API requests that carry an `Origin` header must match `APP_URL`.
- Login always performs one password hash comparison to avoid revealing which emails exist. Auth endpoints are rate limited.
- Email confirmation, password reset (links valid for 1 hour, single-use, resetting signs out all devices) and Google sign-in (verified ID token, only when `GOOGLE_CLIENT_ID` is set).

**Authorization (the part that protects personal data)**
- Route handlers run user queries through `withUser(userId, …)`: a transaction that does `set local role lifesync_app` and sets `app.user_id`. From that point Postgres enforces RLS on every statement.
- `lifesync_app` has no access to `users`, `sessions` or `auth_tokens`.
- Every policy grants access through `workspace_members`. A trigger guarantees a **personal workspace has exactly one member, its owner**, and organization roles exist only in organization workspaces. An organization admin therefore cannot read personal data, whatever the application code does.
- Within an organization: admins manage settings, members and invitations; managers manage projects and assign tasks; members see and work on tasks assigned to them or created by them.
- `withSystem` (RLS bypass) is reserved for registration, login, token redemption, invitation acceptance and the future scheduler. Each call site does its own explicit authorization.
- `apps/server/tests/privacy.test.ts` exercises these guarantees against a real database, including direct SQL as the restricted role.

## 5. Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Setup, authentication, schema, personal and organization workspaces, invitations, dashboard / My Day, quick add, notifications inbox, settings | **Built** |
| 2 | Full task CRUD (edit, duplicate, archive, reschedule), projects, categories, checklists, tags, list + Kanban views, filters and sorting | **Built** |
| 3 | Calendar (day/week/month/agenda, drag to reschedule, conflicts), recurring tasks, reminder scheduler, in-app / email / web push delivery, snooze, retries, missed alerts | **Built** (push not verified on a real device, see section 6) |
| 4 | Task assignment, comments, activity timeline, manager views, project progress, role-based task permissions | **Built** |
| 5 | Focus mode, habits, analytics, notes, polish, accessibility and security review | Planned |

## 6. Known gaps

- **Web push has not been verified on a real device.** The server side (subscriptions, VAPID signing, retries, removal of dead subscriptions, notification actions) is covered by automated tests with a fake push service, and the settings screen and service worker work up to the browser prompt. The automated browser used here runs in incognito mode, where Chrome and Edge disable the Push API, so a real push could not be sent. Please try **Settings > Notifications on this device > Turn on > Send a test** once in a normal browser window.
- Task attachments are not built (schema exists, no upload or storage code yet).
- Comments are plain text: no @mentions, reactions or file attachments. Activity and comments cannot be searched.
- Organization roles are fixed (admin, manager, member); there are no custom roles or per-project membership.
- Kanban moves change a task's status only; the order of cards within a column is not stored.
- Repeating tasks create their next occurrence when the current one is completed or cancelled; future occurrences are not pre-created, so they do not appear on the calendar ahead of time.
- Calendar blocks use the due time as the start (or the start time when one is set on the same day) and the estimate as the length (30 minutes by default).
- No realtime updates; data refreshes on window focus, after your own changes, and the unread counter every minute.

## 6a. How reminders work

1. A reminder is a row in `task_reminders` with an absolute `remind_at` time, so the time zone is applied once, when it is created (the person's zone, `Asia/Dhaka` by default). Moving a task's due time moves its pending "before" reminders automatically (a database trigger); reminders whose new time is already past are cancelled instead of firing late.
2. The scheduler (`apps/server/src/services/scheduler.ts`) wakes every `SCHEDULER_INTERVAL_SECONDS` (30 by default). It claims due reminders with `FOR UPDATE SKIP LOCKED` and a 5-minute lease, so two server instances never send the same reminder and a crashed worker's reminders are picked up again. It does not depend on any browser being open.
3. Each reminder becomes one notification (shown in the app) plus one **delivery row per channel** (`in_app`, `push`, `email`) with its own status, attempt count and last error. Duplicates are impossible by constraint.
4. Failed push/email deliveries are retried after 2, 4, 8 and 16 minutes, then marked `failed`. Unconfirmed email addresses, a missing SMTP server, or no registered device are recorded as `skipped` with the reason. Push subscriptions the browser reports as gone are deleted.
5. Quiet hours hold push and email until they end; the in-app notification still appears. Reminders more than 12 hours late (for example after long downtime) are dropped rather than replayed.
6. "Missed" alerts: once per task and person, for an open timed task that is 15+ minutes overdue (can be switched off in Settings).
7. Notifications can be snoozed or used to complete the task, from the app or from the browser notification itself.

## 6b. Collaboration in organizations

**Who can do what to a task** (the API computes this and sends it as `permissions` on every task, so the screen never guesses):

| | Admin / manager | Member who **created** the task | Member who was only **assigned** it | Other members |
| --- | --- | --- | --- | --- |
| See the task | yes, all tasks | yes | yes | no (404) |
| Change any field, archive, delete | yes | yes | no | no |
| Status, notes, time spent, checklist | yes | yes | **yes** | no |
| Choose assignees | yes | no | no | no |
| Comment | yes | yes | yes | no |

- **Rows** are decided by RLS (`app.can_see_task`); **columns** are decided by the API, because RLS cannot express them. `PATCH /tasks/:id` compares the new values with the stored ones, so a form that resends every field does not trip the rule unless something restricted actually changed. Archiving and deleting are creator, manager and admin only (the delete policy also enforces it in the database).
- **Assigning**: `PUT /tasks/:id/assignees` or `assigneeIds` when creating. Anybody not in the workspace is refused by a database trigger. A task with no `assigneeIds` is assigned to its creator, so it shows on their My Day; a manager may leave it unassigned. Taking someone off a task also cancels their pending reminders for it (done with `withSystem`, since RLS rightly stops a manager editing somebody else's reminders).
- **Comments**: authors edit their own; authors and admins delete (managers moderate nothing they did not write). Comments are removed with their task.
- **Notifications** for assignments and comments go through the same pipeline as reminders (`services/collab.ts` → `createDeliveries`): in-app first, then push and email per the person's preferences, quiet hours and retries. They are written after the request's own transaction, so a notification failure can never undo the action. The author of a comment is never notified of it. Only reminders get the Mark done / Snooze buttons on a push.
- **Activity timeline**: every task change appends to `activity_logs` (created, updated with the names of the fields that really changed, status changed, assigned, unassigned, commented, archived, deleted). Anyone who can see a task reads that task's history (migration 0008); the workspace-wide feed (`GET /workspaces/:id/activity`) is for admins and managers. Deleted tasks keep their title in the entry.
- **Team overview** (`GET /workspaces/:id/team`, admins and managers of an organization): per person open, in progress, due today, overdue and done in the last 7 days, plus unassigned open tasks. A task shared by two people counts once in the totals and once for each person in the table. Project progress is the existing `taskDone / taskTotal` per active project.
- Tests: `apps/server/tests/collab.test.ts` (assignment, the permission table above, comments, notifications incl. push tags, timeline, team counts).

## 7. Running locally

```bash
npm install
npm run db:local        # terminal 1: embedded PostgreSQL on :54329 (leave running)
npm run db:migrate      # apply migrations
npm run dev             # API on :4000 and web on :3000
npm test                # server tests (creates and drops a lifesync_test database)
```

Copy `apps/server/.env.example` to `apps/server/.env`. Without SMTP settings, emails (confirmation, reset, invitations) are printed in the API console, and invitation links are also shown in the UI after you send one.

| Variable | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | server | PostgreSQL connection string |
| `APP_URL` | server | Public web URL (origin check, email links) |
| `GOOGLE_CLIENT_ID` / `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | server / web | Optional Google sign-in; use the same OAuth client ID in both |
| `SMTP_*` | server | Optional email delivery |
| `STORAGE_DIR` | server | Where avatars are stored |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | server | Optional web push keys. Generate with `npm run vapid -w @lifesync/server`. Without them push is disabled and everything else still works |
| `SCHEDULER_INTERVAL_SECONDS` | server | Reminder scheduler interval (default 30, 0 turns it off) |
| `API_ORIGIN` | web | API address for the `/api` proxy (default `http://localhost:4000`) |

**Migrations are append-only.** Once a migration has been applied anywhere, do not edit it; add a new numbered file. (`0006` exists because `0004` was edited after being applied to a development database, which broke organization creation there.)
