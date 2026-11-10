import { DEFAULT_ORGANIZATION_CATEGORIES, DEFAULT_PERSONAL_CATEGORIES, DEFAULT_TIMEZONE } from "@lifesync/shared";
import type { Db } from "../db/pool";
import { conflict } from "../http";
import { hashPassword } from "./crypto";

export interface NewAccount {
  email: string;
  fullName: string;
  password?: string;
  googleSub?: string;
  emailVerified?: boolean;
  timezone?: string;
}

/**
 * Creates the user, profile, notification preferences and the private personal workspace in one
 * transaction. Must run as the system role.
 */
export async function createAccount(db: Db, input: NewAccount): Promise<string> {
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const inserted = await db.query<{ id: string }>(
    `insert into users (email, password_hash, google_sub, email_verified_at)
     values ($1, $2, $3, case when $4::boolean then now() end)
     on conflict (email) do nothing
     returning id`,
    [input.email, passwordHash, input.googleSub ?? null, input.emailVerified ?? false],
  );
  const userId = inserted.rows[0]?.id;
  if (!userId) throw conflict("An account with this email already exists", "email_taken");

  await db.query(`insert into profiles (id, email, full_name, timezone) values ($1, $2, $3, $4)`, [
    userId,
    input.email,
    input.fullName,
    input.timezone ?? DEFAULT_TIMEZONE,
  ]);
  await db.query(`insert into user_notification_preferences (user_id) values ($1)`, [userId]);

  const ws = await db.query<{ id: string }>(
    `insert into workspaces (type, name, description, owner_id, created_by)
     values ('personal', 'Personal', 'Your private space. Only you can see it.', $1, $1)
     returning id`,
    [userId],
  );
  const workspaceId = ws.rows[0]!.id;
  await db.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')`, [
    workspaceId,
    userId,
  ]);
  await seedCategories(db, workspaceId, DEFAULT_PERSONAL_CATEGORIES);
  return userId;
}

export async function seedCategories(
  db: Db,
  workspaceId: string,
  categories: readonly { name: string; color: string }[] = DEFAULT_ORGANIZATION_CATEGORIES,
): Promise<void> {
  for (const c of categories) {
    await db.query(`insert into categories (workspace_id, name, color) values ($1, $2, $3)`, [
      workspaceId,
      c.name,
      c.color,
    ]);
  }
}
