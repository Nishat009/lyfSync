import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "@lifesync/shared";
import { createAccount } from "../auth/accounts";
import { dummyHash, hashPassword, hashToken, newToken, verifyPassword } from "../auth/crypto";
import { endSession, requireAuth, revokeOtherSessions, startSession, uid } from "../auth/sessions";
import type { AppContext } from "../context";
import { withSystem, type Db } from "../db/pool";
import { badRequest, handler, HttpError, parse } from "../http";

const HOUR = 3_600_000;

function limiter(max: number, windowMs: number) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: { code: "rate_limited", message: "Too many attempts. Please wait a bit and try again." } },
  });
}

export function authRouter(ctx: AppContext): Router {
  const r = Router();
  const { config, mailer } = ctx;
  const strict = process.env.NODE_ENV === "test" ? 10_000 : 1;
  const authLimiter = limiter(20 * strict, 15 * 60_000);
  const emailLimiter = limiter(5 * strict, HOUR);

  async function issueToken(db: Db, userId: string, kind: "password_reset" | "email_verification", ttlMs: number) {
    // Only the latest link of each kind stays valid.
    await db.query(`delete from auth_tokens where user_id = $1 and kind = $2`, [userId, kind]);
    const token = newToken();
    await db.query(
      `insert into auth_tokens (user_id, kind, token_hash, expires_at)
       values ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)`,
      [userId, kind, hashToken(token), String(ttlMs)],
    );
    return token;
  }

  async function sendVerification(userId: string, email: string) {
    const token = await withSystem((db) => issueToken(db, userId, "email_verification", 48 * HOUR));
    await mailer.send({
      to: email,
      subject: "Confirm your LifeSync email",
      text: `Welcome to LifeSync.\n\nConfirm your email address: ${config.APP_URL}/verify-email?token=${token}\n\nThis link works for 48 hours.`,
    });
  }

  r.post(
    "/register",
    authLimiter,
    handler(async (req, res) => {
      const input = parse(registerSchema, req.body);
      const userId = await withSystem((db) =>
        createAccount(db, {
          email: input.email,
          fullName: input.fullName,
          password: input.password,
          timezone: input.timezone,
        }),
      );
      await startSession(config, req, res, userId);
      sendVerification(userId, input.email).catch((e) => ctx.log("verification email failed", e));
      res.status(201).json({ ok: true });
    }),
  );

  r.post(
    "/login",
    authLimiter,
    handler(async (req, res) => {
      const input = parse(loginSchema, req.body);
      const user = await withSystem(async (db) => {
        const q = await db.query<{ id: string; password_hash: string | null }>(
          `select id, password_hash from users where email = $1`,
          [input.email],
        );
        return q.rows[0];
      });
      // Always run one hash comparison so response time does not reveal whether the email exists.
      const ok = await verifyPassword(input.password, user?.password_hash ?? (await dummyHash()));
      if (!user || !user.password_hash || !ok) {
        throw new HttpError(401, "invalid_credentials", "Incorrect email or password");
      }
      await startSession(config, req, res, user.id);
      res.json({ ok: true });
    }),
  );

  r.post(
    "/google",
    authLimiter,
    handler(async (req, res) => {
      if (!config.GOOGLE_CLIENT_ID) throw badRequest("Google sign-in is not configured", "google_disabled");
      const { credential } = parse(z.object({ credential: z.string().min(20).max(4096) }), req.body);
      let payload;
      try {
        const client = new OAuth2Client(config.GOOGLE_CLIENT_ID);
        const ticket = await client.verifyIdToken({ idToken: credential, audience: config.GOOGLE_CLIENT_ID });
        payload = ticket.getPayload();
      } catch {
        throw new HttpError(401, "invalid_google_token", "Google sign-in failed. Please try again.");
      }
      if (!payload?.sub || !payload.email || !payload.email_verified) {
        throw new HttpError(401, "invalid_google_token", "Your Google email is not verified");
      }
      const email = payload.email.toLowerCase();
      const userId = await withSystem(async (db) => {
        const bySub = await db.query<{ id: string }>(`select id from users where google_sub = $1`, [payload.sub]);
        if (bySub.rows[0]) return bySub.rows[0].id;
        const byEmail = await db.query<{ id: string }>(`select id from users where email = $1`, [email]);
        if (byEmail.rows[0]) {
          // Google verified this address, so it is safe to link to the existing account.
          await db.query(
            `update users set google_sub = $2, email_verified_at = coalesce(email_verified_at, now()) where id = $1`,
            [byEmail.rows[0].id, payload.sub],
          );
          return byEmail.rows[0].id;
        }
        return createAccount(db, {
          email,
          fullName: (payload.name ?? email.split("@")[0] ?? "LifeSync user").slice(0, 120),
          googleSub: payload.sub,
          emailVerified: true,
        });
      });
      await startSession(config, req, res, userId);
      res.json({ ok: true });
    }),
  );

  r.post(
    "/logout",
    handler(async (req, res) => {
      await endSession(config, req, res);
      res.json({ ok: true });
    }),
  );

  // Always answers the same way, whether or not the email has an account.
  r.post(
    "/forgot-password",
    emailLimiter,
    handler(async (req, res) => {
      const { email } = parse(forgotPasswordSchema, req.body);
      const user = await withSystem(async (db) => {
        const q = await db.query<{ id: string }>(`select id from users where email = $1`, [email]);
        const row = q.rows[0];
        if (!row) return null;
        return { id: row.id, token: await issueToken(db, row.id, "password_reset", HOUR) };
      });
      if (user) {
        mailer
          .send({
            to: email,
            subject: "Reset your LifeSync password",
            text: `Someone asked to reset the password for this LifeSync account.\n\nChoose a new password: ${config.APP_URL}/reset-password?token=${user.token}\n\nThe link works for one hour. If this was not you, ignore this email.`,
          })
          .catch((e) => ctx.log("reset email failed", e));
      }
      res.json({ ok: true });
    }),
  );

  r.post(
    "/reset-password",
    authLimiter,
    handler(async (req, res) => {
      const input = parse(resetPasswordSchema, req.body);
      const hash = await hashPassword(input.password);
      const userId = await withSystem(async (db) => {
        const t = await db.query<{ user_id: string }>(
          `update auth_tokens set used_at = now()
           where token_hash = $1 and kind = 'password_reset' and used_at is null and expires_at > now()
           returning user_id`,
          [hashToken(input.token)],
        );
        const id = t.rows[0]?.user_id;
        if (!id) return null;
        // A reset also proves control of the inbox.
        await db.query(
          `update users set password_hash = $2, email_verified_at = coalesce(email_verified_at, now()) where id = $1`,
          [id, hash],
        );
        await db.query(`delete from sessions where user_id = $1`, [id]);
        return id;
      });
      if (!userId) throw badRequest("This reset link is invalid or has expired", "invalid_token");
      res.json({ ok: true });
    }),
  );

  r.post(
    "/verify-email",
    authLimiter,
    handler(async (req, res) => {
      const { token } = parse(verifyEmailSchema, req.body);
      const ok = await withSystem(async (db) => {
        const t = await db.query<{ user_id: string }>(
          `update auth_tokens set used_at = now()
           where token_hash = $1 and kind = 'email_verification' and used_at is null and expires_at > now()
           returning user_id`,
          [hashToken(token)],
        );
        const id = t.rows[0]?.user_id;
        if (!id) return false;
        await db.query(`update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1`, [id]);
        return true;
      });
      if (!ok) throw badRequest("This confirmation link is invalid or has expired", "invalid_token");
      res.json({ ok: true });
    }),
  );

  r.post(
    "/resend-verification",
    requireAuth,
    emailLimiter,
    handler(async (req, res) => {
      const user = await withSystem(async (db) => {
        const q = await db.query<{ email: string; email_verified_at: Date | null }>(
          `select email, email_verified_at from users where id = $1`,
          [uid(req)],
        );
        return q.rows[0];
      });
      if (user && !user.email_verified_at) await sendVerification(uid(req), user.email);
      res.json({ ok: true });
    }),
  );

  r.post(
    "/change-password",
    requireAuth,
    authLimiter,
    handler(async (req, res) => {
      const input = parse(changePasswordSchema, req.body);
      const userId = uid(req);
      const newHash = await hashPassword(input.newPassword);
      await withSystem(async (db) => {
        const q = await db.query<{ password_hash: string | null }>(
          `select password_hash from users where id = $1 for update`,
          [userId],
        );
        const current = q.rows[0]?.password_hash;
        // Accounts created with Google have no password yet and can set one without a current password.
        if (current) {
          if (!input.currentPassword || !(await verifyPassword(input.currentPassword, current))) {
            throw new HttpError(422, "validation_failed", "Your current password is not correct", {
              currentPassword: "Your current password is not correct",
            });
          }
        }
        await db.query(`update users set password_hash = $2 where id = $1`, [userId, newHash]);
      });
      await revokeOtherSessions(userId, req.sessionId);
      res.json({ ok: true });
    }),
  );

  return r;
}
