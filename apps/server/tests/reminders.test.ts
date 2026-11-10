import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { localDate, zonedToUtc } from "@lifesync/shared";
import { runSchedulerOnce } from "../src/services/scheduler";
import { outside, pushLog, sentMail, setup, signUp, type TestUser } from "./helpers";

let ctx: Awaited<ReturnType<typeof setup>>;
let ana: TestUser;
let ben: TestUser;

const TZ = "Asia/Dhaka";
const MIN = 60_000;
const day = (offset: number) => localDate(Date.now() + offset * 86_400_000, TZ);
/** The instant a task due `date` `time` (Dhaka) is due. */
const at = (date: string, time: string) => zonedToUtc(date, time, TZ);
const tick = (now: Date) => runSchedulerOnce(ctx.deps, now);

async function makeTask(u: TestUser, body: Record<string, unknown> = {}) {
  const res = await u.agent.post("/api/tasks").send({ workspaceId: u.personalId, title: "Task", dueDate: day(10), dueTime: "10:00", ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id as string;
}
const setReminders = (u: TestUser, id: string, offsets: number[], custom: string[] = []) =>
  u.agent.put(`/api/tasks/${id}/reminders`).send({ offsets, custom });
const inbox = async (u: TestUser) => (await u.agent.get("/api/notifications")).body.items as { id: string; type: string; title: string; body: string; link: string; readAt: string | null }[];
const q = (sql: string, params: unknown[] = []) => ctx.pool.query(sql, params);

before(async () => {
  ctx = await setup();
  ana = await signUp(ctx.app, "Ana");
  ben = await signUp(ctx.app, "Ben");
});
after(async () => {
  await ctx.teardown();
});
beforeEach(async () => {
  outside.push = "ok";
  outside.mail = "ok";
  pushLog.length = 0;
  sentMail.length = 0;
  // every test starts from a clean slate of deliveries so counts are exact
  await q(`delete from tasks`); // cascades reminders; keeps earlier tests from raising missed alerts
  await q(`delete from notifications`);
  await q(`update user_notification_preferences set in_app_enabled = true, push_enabled = true, email_enabled = false,
           quiet_hours_enabled = false, missed_reminder_alerts = false, default_reminder_offsets = '{}'`);
  await q(`delete from push_subscriptions`);
});

describe("setting reminders", () => {
  it("stores offset and custom reminders, skipping times already in the past", async () => {
    const id = await makeTask(ana);
    const res = await setReminders(ana, id, [0, 15, 1440], [new Date(Date.now() + 2 * 86_400_000).toISOString(), new Date(Date.now() - 86_400_000).toISOString()]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.created, 4);
    assert.equal(res.body.skipped, 1);
    assert.deepEqual(res.body.reminders.map((r: { offsetMinutes: number | null }) => r.offsetMinutes).sort((a: number | null, b: number | null) => (a ?? 1e9) - (b ?? 1e9)), [0, 15, 1440, null]);
  });

  it("replaces the previous pending reminders instead of adding to them", async () => {
    const id = await makeTask(ana);
    await setReminders(ana, id, [15, 60]);
    const res = await setReminders(ana, id, [5]);
    assert.equal(res.body.reminders.length, 1);
    assert.equal(res.body.reminders[0].offsetMinutes, 5);
  });

  it("rejects unsupported offsets", async () => {
    const id = await makeTask(ana);
    assert.equal((await setReminders(ana, id, [7])).status, 422);
  });

  it("applies the person's default offsets to new tasks with a due time", async () => {
    await q(`update user_notification_preferences set default_reminder_offsets = '{15,60}'`);
    const id = await makeTask(ana);
    const list = await ana.agent.get(`/api/tasks/${id}/reminders`);
    assert.deepEqual(list.body.map((r: { offsetMinutes: number }) => r.offsetMinutes).sort((a: number, b: number) => a - b), [15, 60]);
    const dateOnly = await makeTask(ana, { dueTime: null });
    assert.equal((await ana.agent.get(`/api/tasks/${dateOnly}/reminders`)).body.length, 0);
  });

  it("keeps reminders private to their owner", async () => {
    const id = await makeTask(ana);
    await setReminders(ana, id, [15]);
    assert.equal((await ben.agent.get(`/api/tasks/${id}/reminders`)).status, 404);
    assert.equal((await setReminders(ben, id, [5])).status, 404);
    const upcoming = await ben.agent.get("/api/reminders/upcoming");
    assert.equal(upcoming.body.length, 0);
    const mine = await ana.agent.get("/api/reminders/upcoming");
    assert.equal(mine.body.length, 1);
    assert.equal(mine.body[0].taskTitle, "Task");
  });

  it("moves offset reminders when the task is rescheduled, and drops ones that would be in the past", async () => {
    const id = await makeTask(ana);
    await setReminders(ana, id, [15, 1440]);
    const moved = await ana.agent.patch(`/api/tasks/${id}`).send({ dueDate: day(12), dueTime: "09:00" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const list = (await ana.agent.get(`/api/tasks/${id}/reminders`)).body as { offsetMinutes: number; remindAt: string }[];
    const fifteen = list.find((r) => r.offsetMinutes === 15)!;
    assert.equal(new Date(fifteen.remindAt).getTime(), at(day(12), "09:00").getTime() - 15 * MIN);
    // due in 5 minutes: "1 day before" is long past, so it is cancelled instead of firing late
    const soon = new Date(Date.now() + 5 * MIN);
    await q(`update tasks set due_at = $2 where id = $1`, [id, soon]);
    const after = (await ana.agent.get(`/api/tasks/${id}/reminders`)).body as { offsetMinutes: number }[];
    assert.equal(after.length, 0, "both would now fire in the past, so neither is kept");
  });
});

describe("the scheduler", () => {
  it("does nothing before the reminder time and fires once at it", async () => {
    const id = await makeTask(ana, { title: "Call the bank" });
    await setReminders(ana, id, [15]);
    const due = at(day(10), "10:00");
    assert.deepEqual(await tick(new Date(due.getTime() - 16 * MIN)), { reminders: 0, deliveries: 0, missed: 0 });
    const r = await tick(new Date(due.getTime() - 15 * MIN + 1000));
    assert.equal(r.reminders, 1);
    const items = await inbox(ana);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, "Call the bank");
    assert.match(items[0]!.body, /Due in 15 minutes \(10:00 AM\)/);
    assert.equal(items[0]!.link, `/my-day?task=${id}`);
    const again = await tick(new Date(due.getTime() - 14 * MIN));
    assert.equal(again.reminders, 0);
    assert.equal((await inbox(ana)).length, 1);
    const state = await q(`select status, sent_at from task_reminders`);
    assert.equal(state.rows[0].status, "sent");
  });

  it("never duplicates when two scheduler runs overlap", async () => {
    const id = await makeTask(ana);
    await setReminders(ana, id, [0, 5, 15]);
    const now = new Date(at(day(10), "10:00").getTime() + 1000);
    const [a, b] = await Promise.all([tick(now), tick(now)]);
    assert.equal(a.reminders + b.reminders, 3);
    assert.equal((await inbox(ana)).length, 3);
  });

  it("recovers a reminder whose worker died mid-way", async () => {
    const id = await makeTask(ana);
    await setReminders(ana, id, [0]);
    const due = at(day(10), "10:00");
    // simulate a crashed worker: claimed ten minutes ago and never finished
    await q(`update task_reminders set status = 'processing', locked_at = $1 where task_id = $2`, [new Date(due.getTime() - 10 * MIN), id]);
    const early = await tick(new Date(due.getTime() - 8 * MIN));
    assert.equal(early.reminders, 0, "still within its lease");
    const r = await tick(new Date(due.getTime() + MIN));
    assert.equal(r.reminders, 1);
  });

  it("skips tasks that were completed, archived or deleted before the reminder", async () => {
    const done = await makeTask(ana, { title: "Done early" });
    const archived = await makeTask(ana, { title: "Archived early" });
    const deleted = await makeTask(ana, { title: "Deleted early" });
    for (const id of [done, archived, deleted]) await setReminders(ana, id, [15]);
    await ana.agent.patch(`/api/tasks/${done}/status`).send({ status: "completed" });
    await ana.agent.post(`/api/tasks/${archived}/archive`);
    await ana.agent.delete(`/api/tasks/${deleted}`);
    const r = await tick(new Date(at(day(10), "10:00").getTime()));
    assert.equal(r.reminders, 0);
    assert.equal((await inbox(ana)).length, 0);
    const states = await q(`select status from task_reminders order by status`);
    assert.ok(states.rows.every((s) => s.status === "cancelled"));
  });

  it("drops reminders that are far past instead of replaying them after downtime", async () => {
    const id = await makeTask(ana);
    await setReminders(ana, id, [15]);
    const r = await tick(new Date(at(day(10), "10:00").getTime() + 24 * 3_600_000));
    assert.equal(r.reminders, 0);
    assert.equal((await inbox(ana)).length, 0);
  });

  it("marks in-app as delivered immediately and respects the in-app switch", async () => {
    await q(`update user_notification_preferences set in_app_enabled = false`);
    const id = await makeTask(ana);
    await setReminders(ana, id, [0]);
    await tick(new Date(at(day(10), "10:00").getTime() + 1000));
    const items = await inbox(ana);
    assert.equal(items.length, 1);
    assert.ok(items[0]!.readAt, "kept in history but not shown as unread");
    const d = await q(`select channel from notification_deliveries`);
    assert.equal(d.rows.length, 0);
  });
});

describe("push delivery", () => {
  const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "p".repeat(20), auth: "a".repeat(20) } };

  async function armed(offset = 0) {
    assert.equal((await ana.agent.post("/api/push/subscribe").send(sub)).status, 201);
    const id = await makeTask(ana, { title: "Water plants" });
    await setReminders(ana, id, [offset]);
    return { id, due: at(day(10), "10:00") };
  }

  it("sends a push with the task, a link and the notification id", async () => {
    const { id, due } = await armed();
    const r = await tick(new Date(due.getTime() + 1000));
    assert.equal(r.deliveries, 1);
    assert.equal(pushLog.length, 1);
    assert.equal(pushLog[0]!.payload.title, "Water plants");
    assert.equal(pushLog[0]!.payload.url, `/my-day?task=${id}`);
    assert.ok(pushLog[0]!.payload.notificationId);
    const d = await q(`select status, attempts from notification_deliveries where channel = 'push'`);
    assert.equal(d.rows[0].status, "sent");
  });

  it("retries with backoff and finally gives up, recording the error", async () => {
    outside.push = "fail";
    const { due } = await armed();
    let now = new Date(due.getTime() + 1000);
    await tick(now);
    let d = (await q(`select status, attempts, last_error, next_attempt_at from notification_deliveries where channel = 'push'`)).rows[0];
    assert.equal(d.status, "pending");
    assert.equal(d.attempts, 1);
    assert.match(d.last_error, /unavailable/);
    // not yet due again
    await tick(new Date(now.getTime() + MIN));
    assert.equal(pushLog.length, 1);
    for (let i = 0; i < 6; i++) {
      now = new Date(now.getTime() + 61 * MIN);
      await tick(now);
    }
    d = (await q(`select status, attempts from notification_deliveries where channel = 'push'`)).rows[0];
    assert.equal(d.status, "failed");
    assert.equal(d.attempts, 5);
    assert.equal(pushLog.length, 5);
  });

  it("recovers when a later attempt succeeds", async () => {
    outside.push = "fail";
    const { due } = await armed();
    const now = new Date(due.getTime() + 1000);
    await tick(now);
    outside.push = "ok";
    await tick(new Date(now.getTime() + 10 * MIN));
    const d = (await q(`select status, attempts from notification_deliveries where channel = 'push'`)).rows[0];
    assert.equal(d.status, "sent");
    assert.equal(d.attempts, 2);
  });

  it("removes a subscription the browser says is gone, without retrying", async () => {
    outside.push = "gone";
    const { due } = await armed();
    await tick(new Date(due.getTime() + 1000));
    const d = (await q(`select status, last_error from notification_deliveries where channel = 'push'`)).rows[0];
    assert.equal(d.status, "skipped");
    assert.equal((await q(`select 1 from push_subscriptions`)).rowCount, 0);
  });

  it("does not create a push delivery when the person has no subscribed device", async () => {
    const id = await makeTask(ana);
    await setReminders(ana, id, [0]);
    await tick(new Date(at(day(10), "10:00").getTime() + 1000));
    assert.equal((await q(`select 1 from notification_deliveries where channel = 'push'`)).rowCount, 0);
  });

  it("moves a device to the new account when someone else signs in on it", async () => {
    await ana.agent.post("/api/push/subscribe").send(sub);
    await ben.agent.post("/api/push/subscribe").send(sub);
    const rows = (await q(`select user_id from push_subscriptions`)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, ben.id);
  });

  it("holds push and email until quiet hours end but still shows the in-app notification", async () => {
    await q(`update user_notification_preferences set quiet_hours_enabled = true, quiet_hours_start = '22:00', quiet_hours_end = '07:00', email_enabled = true`);
    await q(`update users set email_verified_at = now()`);
    await ana.agent.post("/api/push/subscribe").send(sub);
    const id = await makeTask(ana, { dueTime: "23:30" });
    await setReminders(ana, id, [0]);
    const due = at(day(10), "23:30");
    await tick(new Date(due.getTime() + 1000));
    assert.equal((await inbox(ana)).length, 1);
    assert.equal(pushLog.length, 0, "held back during quiet hours");
    assert.equal(sentMail.length, 0);
    await tick(new Date(due.getTime() + 3 * 3_600_000));
    assert.equal(pushLog.length, 0, "03:30 is still quiet");
    await tick(at(day(11), "07:00"));
    assert.equal(pushLog.length, 1);
    assert.equal(sentMail.length, 1);
  });
});

describe("email delivery", () => {
  async function armed() {
    await q(`update user_notification_preferences set email_enabled = true`);
    const id = await makeTask(ana, { title: "Pay rent" });
    await setReminders(ana, id, [0]);
    return at(day(10), "10:00");
  }

  it("emails verified addresses", async () => {
    await q(`update users set email_verified_at = now()`);
    const due = await armed();
    await tick(new Date(due.getTime() + 1000));
    const mail = sentMail.find((m) => m.subject === "Pay rent");
    assert.ok(mail, "reminder email sent");
    assert.match(mail.text, /Due now/);
    assert.match(mail.text, /\/my-day\?task=/);
  });

  it("skips unverified addresses and says why", async () => {
    await q(`update users set email_verified_at = null`);
    const due = await armed();
    await tick(new Date(due.getTime() + 1000));
    const d = (await q(`select status, last_error from notification_deliveries where channel = 'email'`)).rows[0];
    assert.equal(d.status, "skipped");
    assert.match(d.last_error, /not confirmed/);
  });

  it("records 'skipped' when SMTP is not configured, and retries when the server errors", async () => {
    await q(`update users set email_verified_at = now()`);
    outside.mail = "off";
    let due = await armed();
    await tick(new Date(due.getTime() + 1000));
    assert.match((await q(`select last_error from notification_deliveries where channel = 'email'`)).rows[0].last_error, /SMTP is not configured/);

    await q(`delete from notifications`);
    await q(`delete from task_reminders`);
    outside.mail = "fail";
    due = await armed();
    await tick(new Date(due.getTime() + 1000));
    const d = (await q(`select status, attempts from notification_deliveries where channel = 'email'`)).rows[0];
    assert.equal(d.status, "pending");
    assert.equal(d.attempts, 1);
  });
});

describe("snooze and act from a notification", () => {
  async function fired(title = "Snooze me") {
    const id = await makeTask(ana, { title });
    await setReminders(ana, id, [0]);
    const due = at(day(10), "10:00");
    await tick(new Date(due.getTime() + 1000));
    const n = (await inbox(ana)).find((x) => x.title === title)!;
    return { id, due, n };
  }

  it("snoozing schedules a new reminder and marks the notification read", async () => {
    const { due, n } = await fired();
    const res = await ana.agent.post(`/api/notifications/${n.id}/snooze`).send({ minutes: 10 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await inbox(ana)).find((x) => x.id === n.id)!.readAt !== null, true);
    // the snooze was relative to real time, so move the pending reminder into the simulated clock
    await q(`update task_reminders set remind_at = $1 where status = 'pending'`, [new Date(due.getTime() + 10 * MIN)]);
    assert.equal((await tick(new Date(due.getTime() + 5 * MIN))).reminders, 0);
    assert.equal((await tick(new Date(due.getTime() + 11 * MIN))).reminders, 1);
    assert.equal((await inbox(ana)).filter((x) => x.title === "Snooze me").length, 2);
  });

  it("completes the task straight from the notification", async () => {
    const { id, n } = await fired("Finish me");
    const res = await ana.agent.post(`/api/notifications/${n.id}/complete`);
    assert.equal(res.status, 200);
    assert.equal((await ana.agent.get(`/api/tasks/${id}`)).body.status, "completed");
  });

  it("does not let someone act on another person's notification", async () => {
    const { id, n } = await fired("Mine only");
    assert.equal((await ben.agent.post(`/api/notifications/${n.id}/complete`)).status, 404);
    assert.equal((await ben.agent.post(`/api/notifications/${n.id}/snooze`).send({ minutes: 5 })).status, 404);
    assert.equal((await ana.agent.get(`/api/tasks/${id}`)).body.status, "todo");
  });
});

describe("missed alerts", () => {
  it("alerts once about an open timed task that is overdue, never for finished or fresh ones", async () => {
    await q(`update user_notification_preferences set missed_reminder_alerts = true`);
    const overdue = await makeTask(ana, { title: "Overdue call", dueDate: day(0), dueTime: "00:01" });
    const finished = await makeTask(ana, { title: "Finished call", dueDate: day(0), dueTime: "00:01", status: "completed" });
    const future = await makeTask(ana, { title: "Future call" });
    const now = new Date(at(day(0), "00:01").getTime() + 30 * MIN);
    const first = await tick(now);
    assert.equal(first.missed, 1);
    const items = (await inbox(ana)).filter((n) => n.type === "missed");
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, "Missed: Overdue call");
    assert.equal((await tick(new Date(now.getTime() + 60 * MIN))).missed, 0, "only once");
    assert.ok(overdue && finished && future);
  });

  it("is off when the person turns it off", async () => {
    await makeTask(ana, { title: "Quiet overdue", dueDate: day(0), dueTime: "00:01" });
    const r = await tick(new Date(at(day(0), "00:01").getTime() + 30 * MIN));
    assert.equal(r.missed, 0);
  });
});

describe("calendar", () => {
  it("returns tasks and reminders in the range for the signed-in person only", async () => {
    const a = await makeTask(ana, { title: "Cal A", dueDate: day(3), dueTime: "14:00" });
    await makeTask(ben, { title: "Cal B", dueDate: day(3), dueTime: "14:00" });
    await setReminders(ana, a, [15]);
    const res = await ana.agent.get(`/api/calendar?from=${day(0)}&to=${day(7)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const titles = res.body.items.map((i: { title: string }) => i.title);
    assert.ok(titles.includes("Cal A"));
    assert.ok(!titles.includes("Cal B"));
    assert.equal(res.body.reminders.length, 1);
    assert.equal(res.body.timezone, TZ);
    const outside2 = await ana.agent.get(`/api/calendar?from=${day(20)}&to=${day(27)}`);
    assert.ok(!outside2.body.items.some((i: { title: string }) => i.title === "Cal A"));
  });

  it("rejects absurd ranges", async () => {
    assert.equal((await ana.agent.get(`/api/calendar?from=${day(0)}&to=${day(400)}`)).status, 400);
    assert.equal((await ana.agent.get(`/api/calendar?from=${day(5)}&to=${day(1)}`)).status, 400);
  });
});
