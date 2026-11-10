import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { localDate, nextOccurrence, type Recurrence } from "@lifesync/shared";
import { setup, signUp, type TestUser } from "./helpers";

const rule = (r: Partial<Recurrence>): Recurrence => ({
  frequency: "daily",
  interval: 1,
  byWeekday: [],
  byMonthday: null,
  endsOn: null,
  maxCount: null,
  ...r,
});

describe("nextOccurrence", () => {
  it("daily and every N days stay on their grid", () => {
    assert.equal(nextOccurrence(rule({}), "2026-11-10", "2026-11-10"), "2026-11-11");
    assert.equal(nextOccurrence(rule({ interval: 3 }), "2026-11-10", "2026-11-10"), "2026-11-13");
    assert.equal(nextOccurrence(rule({ interval: 3 }), "2026-11-10", "2026-11-14"), "2026-11-16");
  });

  it("every weekday skips the weekend", () => {
    const wk = rule({ frequency: "weekly", byWeekday: [1, 2, 3, 4, 5] });
    assert.equal(nextOccurrence(wk, "2026-11-09", "2026-11-13"), "2026-11-16"); // Fri -> Mon
    assert.equal(nextOccurrence(wk, "2026-11-09", "2026-11-09"), "2026-11-10");
  });

  it("weekly on selected days, and every other week", () => {
    const mwf = rule({ frequency: "weekly", byWeekday: [1, 3, 5] });
    assert.equal(nextOccurrence(mwf, "2026-11-09", "2026-11-09"), "2026-11-11");
    const biweekly = rule({ frequency: "weekly", interval: 2, byWeekday: [1] });
    assert.equal(nextOccurrence(biweekly, "2026-11-09", "2026-11-09"), "2026-11-23");
  });

  it("weekly without chosen days repeats on the same weekday", () => {
    assert.equal(nextOccurrence(rule({ frequency: "weekly" }), "2026-11-10", "2026-11-10"), "2026-11-17");
  });

  it("monthly clamps to short months and recovers", () => {
    const m = rule({ frequency: "monthly" });
    assert.equal(nextOccurrence(m, "2026-01-31", "2026-01-31"), "2026-02-28");
    assert.equal(nextOccurrence(m, "2026-01-31", "2026-02-28"), "2026-03-31");
    assert.equal(nextOccurrence(rule({ frequency: "monthly", byMonthday: 15 }), "2026-11-10", "2026-11-10"), "2026-11-15");
    assert.equal(nextOccurrence(rule({ frequency: "monthly", interval: 3 }), "2026-11-10", "2026-11-10"), "2027-02-10");
  });

  it("yearly handles leap days", () => {
    const y = rule({ frequency: "yearly" });
    assert.equal(nextOccurrence(y, "2028-02-29", "2028-02-29"), "2029-02-28");
    assert.equal(nextOccurrence(y, "2026-11-10", "2026-11-10"), "2027-11-10");
  });

  it("stops at the end date", () => {
    assert.equal(nextOccurrence(rule({ endsOn: "2026-11-11" }), "2026-11-10", "2026-11-10"), "2026-11-11");
    assert.equal(nextOccurrence(rule({ endsOn: "2026-11-11" }), "2026-11-10", "2026-11-11"), null);
  });
});

let ctx: Awaited<ReturnType<typeof setup>>;
let ana: TestUser;
let ben: TestUser;
const TZ = "Asia/Dhaka";
const day = (offset: number) => localDate(Date.now() + offset * 86_400_000, TZ);

before(async () => {
  ctx = await setup();
  ana = await signUp(ctx.app, "Ana");
  ben = await signUp(ctx.app, "Ben");
});
after(async () => {
  await ctx.teardown();
});
beforeEach(async () => {
  await ctx.pool.query(`update user_notification_preferences set default_reminder_offsets = '{}'`);
});

async function repeating(u: TestUser, over: Record<string, unknown> = {}, recurrence: Partial<Recurrence> = {}) {
  const res = await u.agent.post("/api/tasks").send({
    workspaceId: u.personalId,
    title: "Daily review",
    dueDate: day(0),
    dueTime: "17:00",
    recurrence: rule(recurrence),
    ...over,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id as string;
}
const all = async (u: TestUser) => (await u.agent.get(`/api/tasks?workspaceId=${u.personalId}&limit=100`)).body as { id: string; title: string; status: string; dueDate: string; recurring: boolean }[];

describe("recurring tasks", () => {
  it("creating the next occurrence when one is completed", async () => {
    const id = await repeating(ana);
    await ana.agent.post(`/api/tasks/${id}/subtasks`).send({ title: "Check inbox" });
    const sub = (await ana.agent.get(`/api/tasks/${id}`)).body.subtasks[0];
    await ana.agent.patch(`/api/tasks/${id}/subtasks/${sub.id}`).send({ isDone: true });
    assert.equal((await ana.agent.patch(`/api/tasks/${id}/status`).send({ status: "completed" })).status, 200);
    const tasks = (await all(ana)).filter((t) => t.title === "Daily review");
    assert.equal(tasks.length, 2);
    const next = tasks.find((t) => t.status === "todo")!;
    assert.equal(next.dueDate, day(1));
    assert.equal(next.recurring, true);
    const detail = (await ana.agent.get(`/api/tasks/${next.id}`)).body;
    assert.equal(detail.dueTime, "17:00");
    assert.equal(detail.subtasks.length, 1);
    assert.equal(detail.subtasks[0].isDone, false, "checklist is reset");
    assert.equal(detail.recurrence.frequency, "daily");
  });

  it("completing twice (or via edit) does not create two followers", async () => {
    const id = await repeating(ana, { title: "Once only" });
    await ana.agent.patch(`/api/tasks/${id}/status`).send({ status: "completed" });
    await ana.agent.patch(`/api/tasks/${id}/status`).send({ status: "todo" });
    await ana.agent.patch(`/api/tasks/${id}`).send({ status: "completed" });
    assert.equal((await all(ana)).filter((t) => t.title === "Once only").length, 2);
  });

  it("never schedules the next occurrence in the past when finished late", async () => {
    const id = await repeating(ana, { title: "Late finisher", dueDate: day(-5) });
    await ana.agent.patch(`/api/tasks/${id}/status`).send({ status: "completed" });
    const next = (await all(ana)).find((t) => t.title === "Late finisher" && t.status === "todo")!;
    assert.equal(next.dueDate, day(0), "the first daily slot that is not already over");
  });

  it("cancelling an occurrence also moves the series on", async () => {
    const id = await repeating(ana, { title: "Skippable" });
    await ana.agent.patch(`/api/tasks/${id}/status`).send({ status: "cancelled" });
    assert.ok((await all(ana)).some((t) => t.title === "Skippable" && t.status === "todo"));
  });

  it("copies the person's reminder offsets onto the next occurrence", async () => {
    const id = await repeating(ana, { title: "With reminder", dueDate: day(10) });
    await ana.agent.put(`/api/tasks/${id}/reminders`).send({ offsets: [15, 60], custom: [] });
    await ana.agent.patch(`/api/tasks/${id}/status`).send({ status: "completed" });
    const next = (await all(ana)).find((t) => t.title === "With reminder" && t.status === "todo")!;
    const reminders = (await ana.agent.get(`/api/tasks/${next.id}/reminders`)).body as { offsetMinutes: number }[];
    assert.deepEqual(reminders.map((r) => r.offsetMinutes).sort((a, b) => a - b), [15, 60]);
  });

  it("stops after the maximum count and after the end date", async () => {
    const id = await repeating(ana, { title: "Twice" }, { maxCount: 2 });
    await ana.agent.patch(`/api/tasks/${id}/status`).send({ status: "completed" });
    const second = (await all(ana)).find((t) => t.title === "Twice" && t.status === "todo")!;
    await ana.agent.patch(`/api/tasks/${second.id}/status`).send({ status: "completed" });
    assert.equal((await all(ana)).filter((t) => t.title === "Twice").length, 2);

    const e = await repeating(ana, { title: "Ends soon" }, { endsOn: day(0) });
    await ana.agent.patch(`/api/tasks/${e}/status`).send({ status: "completed" });
    assert.equal((await all(ana)).filter((t) => t.title === "Ends soon").length, 1);
  });

  it("weekly on selected weekdays lands on a chosen weekday", async () => {
    const id = await repeating(ana, { title: "Weekdays", dueDate: day(0) }, { frequency: "weekly", byWeekday: [1, 2, 3, 4, 5] });
    await ana.agent.patch(`/api/tasks/${id}/status`).send({ status: "completed" });
    const next = (await all(ana)).find((t) => t.title === "Weekdays" && t.status === "todo")!;
    const weekday = new Date(`${next.dueDate}T00:00:00Z`).getUTCDay();
    assert.ok(weekday >= 1 && weekday <= 5);
  });

  it("can be edited and turned off", async () => {
    const id = await repeating(ana, { title: "Editable", dueDate: day(10) });
    const edited = await ana.agent.patch(`/api/tasks/${id}`).send({ recurrence: rule({ frequency: "weekly", byWeekday: [2] }) });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.recurrence.frequency, "weekly");
    assert.deepEqual(edited.body.recurrence.byWeekday, [2]);
    const off = await ana.agent.patch(`/api/tasks/${id}`).send({ recurrence: null });
    assert.equal(off.body.recurrence, null);
    await ana.agent.patch(`/api/tasks/${id}/status`).send({ status: "completed" });
    assert.equal((await all(ana)).filter((t) => t.title === "Editable").length, 1);
  });

  it("requires a due date", async () => {
    const res = await ana.agent.post("/api/tasks").send({ workspaceId: ana.personalId, title: "No date", recurrence: rule({}) });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.dueDate);
  });

  it("keeps someone else's series untouchable", async () => {
    const id = await repeating(ana, { title: "Hers" });
    assert.equal((await ben.agent.patch(`/api/tasks/${id}`).send({ recurrence: null })).status, 404);
    assert.equal((await ben.agent.patch(`/api/tasks/${id}/status`).send({ status: "completed" })).status, 404);
    assert.equal((await all(ben)).length, 0);
  });
});
