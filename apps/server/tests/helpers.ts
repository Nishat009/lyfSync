import pg from "pg";
import request from "supertest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { closePool, createPool } from "../src/db/pool";
import { runMigrations } from "../src/db/migrate";
import type { Mail, Mailer } from "../src/services/mailer";
import type { PushPayload, PushSender, PushTarget } from "../src/services/push";

process.env.NODE_ENV = "test";

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/lifesync";
const testDb = "lifesync_test";

export const sentMail: Mail[] = [];

/** Test doubles for the outside world: what was pushed, and whether delivery should work. */
export const pushLog: { target: PushTarget; payload: PushPayload }[] = [];
export const outside = { push: "ok" as "ok" | "gone" | "fail", mail: "ok" as "ok" | "fail" | "off" };

const fakePush: PushSender = {
  configured: true,
  publicKey: "test-public-key",
  async send(target, payload) {
    pushLog.push({ target, payload });
    if (outside.push === "gone") return { ok: false, gone: true, error: "gone" };
    if (outside.push === "fail") return { ok: false, gone: false, error: "push service unavailable" };
    return { ok: true };
  },
};

const fakeMailer: Mailer = {
  async send(mail) {
    if (outside.mail === "fail") throw new Error("smtp down");
    if (outside.mail === "off") return false;
    sentMail.push(mail);
    return true;
  },
};

/** Drops and recreates the test database, applies migrations and returns a ready app. */
export async function setup() {
  const admin = new pg.Client({ connectionString: baseUrl.replace(/\/[^/]*$/, "/postgres") });
  await admin.connect();
  await admin.query(`drop database if exists ${testDb} with (force)`);
  await admin.query(`create database ${testDb}`);
  await admin.end();

  const url = baseUrl.replace(/\/[^/]*$/, `/${testDb}`);
  await runMigrations(url, () => undefined);
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: url, APP_URL: "http://localhost:3000" } as NodeJS.ProcessEnv);
  const pool = createPool(url);
  const log = () => undefined;
  const app = createApp({ config, log, mailer: fakeMailer, push: fakePush });
  const deps = { config, log, mailer: fakeMailer, push: fakePush };
  return { app, pool, url, deps, teardown: closePool };
}

let counter = 0;

export interface TestUser {
  agent: ReturnType<typeof request.agent>;
  id: string;
  email: string;
  personalId: string;
}

export async function signUp(app: Parameters<typeof request>[0], name: string): Promise<TestUser> {
  const email = `${name.toLowerCase()}${++counter}@example.com`;
  const agent = request.agent(app);
  const reg = await agent.post("/api/auth/register").send({ fullName: name, email, password: "correct-horse-1" });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const me = await agent.get("/api/me");
  const personal = me.body.workspaces.find((w: { type: string }) => w.type === "personal");
  return { agent, id: me.body.user.id, email, personalId: personal.id };
}

/** Pulls the invitation token out of the latest invitation email. */
export function lastInviteToken(): string {
  const mail = [...sentMail].reverse().find((m) => m.text.includes("/invite?token="));
  const match = mail?.text.match(/token=([\w-]+)/);
  if (!match) throw new Error("no invitation email captured");
  return match[1]!;
}
