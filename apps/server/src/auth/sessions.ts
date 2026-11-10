import type { CookieOptions, NextFunction, Request, Response } from "express";
import type { Config } from "../config";
import { withSystem } from "../db/pool";
import { unauthorized } from "../http";
import { hashToken, newToken } from "./crypto";

export const SESSION_COOKIE = "ls_session";

declare module "express-serve-static-core" {
  interface Request {
    /** Set by requireAuth. */
    userId?: string;
    sessionId?: string;
  }
}

function cookieOptions(config: Config, maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: maxAgeMs,
  };
}

export async function startSession(config: Config, req: Request, res: Response, userId: string): Promise<void> {
  const token = newToken();
  const ttlMs = config.SESSION_TTL_DAYS * 86_400_000;
  await withSystem(async (db) => {
    await db.query(
      `insert into sessions (user_id, token_hash, user_agent, ip, expires_at)
       values ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)`,
      [userId, hashToken(token), req.get("user-agent")?.slice(0, 512) ?? null, req.ip ?? null, String(ttlMs)],
    );
    await db.query(`update users set last_login_at = now() where id = $1`, [userId]);
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions(config, ttlMs));
}

export async function endSession(config: Config, req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string") {
    await withSystem((db) => db.query(`delete from sessions where token_hash = $1`, [hashToken(token)]));
  }
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(config, 0), maxAge: undefined });
}

/** Revokes every session of a user except (optionally) the current one. */
export async function revokeOtherSessions(userId: string, keepSessionId?: string): Promise<void> {
  await withSystem((db) =>
    db.query(`delete from sessions where user_id = $1 and ($2::uuid is null or id <> $2)`, [
      userId,
      keepSessionId ?? null,
    ]),
  );
}

export async function resolveSession(token: string): Promise<{ userId: string; sessionId: string } | null> {
  return withSystem(async (db) => {
    const r = await db.query<{ id: string; user_id: string; last_seen_at: Date }>(
      `select id, user_id, last_seen_at from sessions where token_hash = $1 and expires_at > now()`,
      [hashToken(token)],
    );
    const row = r.rows[0];
    if (!row) return null;
    // Touch at most once every few minutes to avoid a write per request.
    if (Date.now() - row.last_seen_at.getTime() > 5 * 60_000) {
      await db.query(`update sessions set last_seen_at = now() where id = $1`, [row.id]);
    }
    return { userId: row.user_id, sessionId: row.id };
  });
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== "string" || token.length < 20) throw unauthorized();
    const session = await resolveSession(token);
    if (!session) throw unauthorized("Your session has expired. Please sign in again.");
    req.userId = session.userId;
    req.sessionId = session.sessionId;
    next();
  } catch (err) {
    next(err);
  }
}

/** Convenience for handlers behind requireAuth. */
export function uid(req: Request): string {
  if (!req.userId) throw unauthorized();
  return req.userId;
}
