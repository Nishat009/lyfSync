import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodType } from "zod";
import type { ApiErrorBody } from "@lifesync/shared";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "bad_request") => new HttpError(400, code, message);
export const unauthorized = (message = "Sign in to continue") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "You do not have permission to do that") =>
  new HttpError(403, "forbidden", message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);

/** Wraps an async handler so rejected promises reach the error middleware (Express 5 does this too; kept explicit for clarity). */
export const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** Parses `data` with a Zod schema; throws a 422 with per-field messages on failure. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "_";
    fields[key] ??= issue.message;
  }
  throw new HttpError(422, "validation_failed", "Please check the highlighted fields", fields);
}

export function errorMiddleware(log: (msg: string, err: unknown) => void) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      const body: ApiErrorBody = { error: { code: err.code, message: err.message, fields: err.fields } };
      res.status(err.status).json(body);
      return;
    }
    // body-parser and multer errors carry their own status
    const e = err as { status?: number; type?: string; code?: string };
    if (e?.type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "bad_json", message: "Malformed JSON body" } });
      return;
    }
    if (e?.type === "entity.too.large" || e?.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: { code: "too_large", message: "That request is too large" } });
      return;
    }
    // Postgres integrity errors that reach here are almost always a guard trigger or constraint
    const pgErr = err as { code?: string; message?: string };
    if (pgErr?.code === "23514") {
      res.status(409).json({ error: { code: "constraint", message: pgErr.message ?? "Not allowed" } });
      return;
    }
    if (pgErr?.code === "42501") {
      res.status(403).json({ error: { code: "forbidden", message: "You do not have permission to do that" } });
      return;
    }
    log("unhandled error", err);
    res.status(500).json({ error: { code: "internal", message: "Something went wrong. Please try again." } });
  };
}
