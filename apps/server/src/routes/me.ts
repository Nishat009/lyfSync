import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import {
  LIMITS,
  notificationPreferencesSchema,
  updateProfileSchema,
  uuidSchema,
  type Me,
  type NotificationPreferences,
  type WorkspaceSummary,
} from "@lifesync/shared";
import { requireAuth, uid } from "../auth/sessions";
import type { AppContext } from "../context";
import { withSystem, withUser, type Db } from "../db/pool";
import { badRequest, handler, notFound, parse } from "../http";
import { countPendingInvitations } from "../services/invitations";

export async function listWorkspaces(db: Db): Promise<WorkspaceSummary[]> {
  const q = await db.query(
    `select w.id, w.type, w.name, w.description, m.role,
            (select count(*)::int from workspace_members c where c.workspace_id = w.id) as member_count
     from workspaces w
     join workspace_members m on m.workspace_id = w.id and m.user_id = app.current_user_id()
     order by (w.type = 'personal') desc, lower(w.name)`,
  );
  return q.rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    description: r.description,
    role: r.role,
    memberCount: r.member_count,
  }));
}

export function toPrefs(r: Record<string, unknown>): NotificationPreferences {
  const time = (v: unknown) => (typeof v === "string" ? v.slice(0, 5) : null);
  return {
    inAppEnabled: r.in_app_enabled as boolean,
    pushEnabled: r.push_enabled as boolean,
    emailEnabled: r.email_enabled as boolean,
    defaultReminderOffsets: r.default_reminder_offsets as number[],
    missedReminderAlerts: r.missed_reminder_alerts as boolean,
    quietHoursEnabled: r.quiet_hours_enabled as boolean,
    quietHoursStart: time(r.quiet_hours_start),
    quietHoursEnd: time(r.quiet_hours_end),
  };
}

export function meRouter(ctx: AppContext): Router {
  const r = Router();
  const avatarDir = path.resolve(ctx.config.STORAGE_DIR, "avatars");
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LIMITS.avatarMaxBytes, files: 1 } });

  r.use(requireAuth);

  r.get(
    "/me",
    handler(async (req, res) => {
      const userId = uid(req);
      const account = await withSystem(async (db) => {
        const q = await db.query(
          `select email, email_verified_at, password_hash is not null as has_password, google_sub is not null as has_google
           from users where id = $1`,
          [userId],
        );
        return q.rows[0];
      });
      if (!account) throw notFound();
      const data = await withUser(userId, async (db) => {
        const p = await db.query(
          `select id, email, full_name, avatar_path, timezone, week_starts_on from profiles where id = $1`,
          [userId],
        );
        const unread = await db.query(`select count(*)::int as n from notifications where read_at is null`);
        return { profile: p.rows[0], workspaces: await listWorkspaces(db), unread: unread.rows[0].n as number };
      });
      const body: Me = {
        user: {
          id: userId,
          email: account.email,
          emailVerified: account.email_verified_at !== null,
          hasPassword: account.has_password,
          hasGoogle: account.has_google,
        },
        profile: {
          id: userId,
          email: data.profile.email,
          fullName: data.profile.full_name,
          avatarUrl: data.profile.avatar_path
            ? `/api/avatars/${userId}?v=${encodeURIComponent(data.profile.avatar_path)}`
            : null,
          timezone: data.profile.timezone,
          weekStartsOn: data.profile.week_starts_on,
        },
        workspaces: data.workspaces,
        unreadNotifications: data.unread,
        pendingInvitations: await countPendingInvitations(account.email, account.email_verified_at !== null),
      };
      res.json(body);
    }),
  );

  r.patch(
    "/profile",
    handler(async (req, res) => {
      const input = parse(updateProfileSchema, req.body);
      await withUser(uid(req), (db) =>
        db.query(`update profiles set full_name = $1, timezone = $2, week_starts_on = $3 where id = $4`, [
          input.fullName,
          input.timezone,
          input.weekStartsOn,
          uid(req),
        ]),
      );
      res.json({ ok: true });
    }),
  );

  r.get(
    "/notification-preferences",
    handler(async (req, res) => {
      const row = await withUser(uid(req), async (db) => {
        const q = await db.query(`select * from user_notification_preferences where user_id = $1`, [uid(req)]);
        return q.rows[0];
      });
      if (!row) throw notFound();
      res.json(toPrefs(row));
    }),
  );

  r.put(
    "/notification-preferences",
    handler(async (req, res) => {
      const p = parse(notificationPreferencesSchema, req.body);
      const row = await withUser(uid(req), async (db) => {
        const q = await db.query(
          `update user_notification_preferences set
             in_app_enabled = $2, push_enabled = $3, email_enabled = $4, default_reminder_offsets = $5,
             missed_reminder_alerts = $6, quiet_hours_enabled = $7, quiet_hours_start = $8, quiet_hours_end = $9
           where user_id = $1 returning *`,
          [
            uid(req),
            p.inAppEnabled,
            p.pushEnabled,
            p.emailEnabled,
            p.defaultReminderOffsets,
            p.missedReminderAlerts,
            p.quietHoursEnabled,
            p.quietHoursStart,
            p.quietHoursEnd,
          ],
        );
        return q.rows[0];
      });
      res.json(toPrefs(row));
    }),
  );

  // ---- Avatar ----

  r.post(
    "/profile/avatar",
    upload.single("avatar"),
    handler(async (req, res) => {
      const file = req.file;
      if (!file) throw badRequest("Choose an image to upload", "no_file");
      let output: Buffer;
      try {
        // Decoding and re-encoding strips metadata and rejects anything that is not a real image.
        output = await sharp(file.buffer, { limitInputPixels: 40_000_000 })
          .rotate()
          .resize(256, 256, { fit: "cover" })
          .webp({ quality: 85 })
          .toBuffer();
      } catch {
        throw badRequest("That file is not a supported image", "bad_image");
      }
      await mkdir(avatarDir, { recursive: true });
      await writeFile(path.join(avatarDir, `${uid(req)}.webp`), output);
      const version = Date.now().toString(36);
      await withUser(uid(req), (db) => db.query(`update profiles set avatar_path = $1 where id = $2`, [version, uid(req)]));
      res.json({ avatarUrl: `/api/avatars/${uid(req)}?v=${version}` });
    }),
  );

  r.delete(
    "/profile/avatar",
    handler(async (req, res) => {
      await withUser(uid(req), (db) => db.query(`update profiles set avatar_path = null where id = $1`, [uid(req)]));
      await rm(path.join(avatarDir, `${uid(req)}.webp`), { force: true });
      res.json({ ok: true });
    }),
  );

  // Visible to people who share a workspace with the owner (the profiles RLS policy decides).
  r.get(
    "/avatars/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const visible = await withUser(uid(req), async (db) => {
        const q = await db.query(`select avatar_path from profiles where id = $1`, [id]);
        return q.rows[0]?.avatar_path as string | null | undefined;
      });
      if (!visible) throw notFound();
      try {
        const data = await readFile(path.join(avatarDir, `${id}.webp`));
        res.set({ "Content-Type": "image/webp", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
        res.send(data);
      } catch {
        throw notFound();
      }
    }),
  );

  return r;
}
