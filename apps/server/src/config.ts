import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /** Public URL of the web app. Used for CORS/origin checks and links in emails. */
  APP_URL: z.string().url().default("http://localhost:3000"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  COOKIE_SECURE: bool.optional(),
  /** Number of reverse proxies in front of the API (for correct client IPs in rate limiting). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  GOOGLE_CLIENT_ID: z.string().optional(),

  /** Web push (VAPID). Generate a pair with `npm run vapid`. Push is disabled when these are empty. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),

  /** How often the reminder scheduler wakes up. 0 turns the in-process scheduler off. */
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(30),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("LifeSync <no-reply@lifesync.local>"),

  STORAGE_DIR: z.string().default("storage"),
});

export type Config = z.infer<typeof schema> & { cookieSecure: boolean; isProd: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  const c = parsed.data;
  const isProd = c.NODE_ENV === "production";
  return { ...c, isProd, cookieSecure: c.COOKIE_SECURE ?? isProd };
}
