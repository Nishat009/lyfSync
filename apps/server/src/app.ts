import cookieParser from "cookie-parser";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import type { AppContext } from "./context";
import { getPool } from "./db/pool";
import { errorMiddleware, handler, HttpError } from "./http";
import { authRouter } from "./routes/auth";
import { dashboardRouter } from "./routes/dashboard";
import { invitationsRouter } from "./routes/invitations";
import { meRouter } from "./routes/me";
import { notificationsRouter } from "./routes/notifications";
import { projectsRouter } from "./routes/projects";
import { remindersRouter } from "./routes/reminders";
import { tasksRouter } from "./routes/tasks";
import { teamRouter } from "./routes/team";
import { workspacesRouter } from "./routes/workspaces";

/**
 * CSRF defence in depth on top of SameSite=Lax cookies: a state-changing request that carries an
 * Origin header must come from the web app. Requests with no Origin (curl, server-to-server) have
 * no ambient browser credentials to abuse.
 */
function sameOriginOnly(appUrl: string) {
  const allowed = new URL(appUrl).origin;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    if (origin && origin !== allowed) {
      return next(new HttpError(403, "bad_origin", "Request origin is not allowed"));
    }
    next();
  };
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable("x-powered-by");
  if (ctx.config.TRUST_PROXY > 0) app.set("trust proxy", ctx.config.TRUST_PROXY);

  app.use(helmet({ contentSecurityPolicy: false })); // JSON API only; the web app sets its own CSP
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());
  app.use("/api", sameOriginOnly(ctx.config.APP_URL));

  app.get(
    "/api/health",
    handler(async (_req, res) => {
      await getPool().query("select 1");
      res.json({ ok: true });
    }),
  );

  app.use("/api/auth", authRouter(ctx));
  app.use("/api/workspaces", workspacesRouter(ctx));
  app.use("/api/workspaces", teamRouter(ctx)); // /:id/team, /:id/activity (managers)
  app.use("/api/invitations", invitationsRouter(ctx));
  app.use("/api/tasks", tasksRouter(ctx));
  app.use("/api", remindersRouter(ctx)); // task reminders, push, calendar
  app.use("/api", projectsRouter(ctx)); // /workspaces/:id/projects, /projects/:id, categories
  app.use("/api/dashboard", dashboardRouter(ctx));
  app.use("/api/notifications", notificationsRouter(ctx));
  app.use("/api", meRouter(ctx)); // /me, /profile, /notification-preferences, /avatars

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "not_found", "No such endpoint")));
  app.use(errorMiddleware((msg, err) => ctx.log(msg, err)));
  return app;
}
