import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { addDays, localDate } from "@lifesync/shared";
import { computeStreaks } from "../src/services/habits";
import { lastInviteToken, setup, signUp, type TestUser } from "./helpers";

let ctx: Awaited<ReturnType<typeof setup>>;
let ana: TestUser;
let ben: TestUser;
let orgId: string;
const q = (sql: string, params: unknown[] = []) => ctx.pool.query(sql, params);
const today = () => localDate(new Date(), "Asia/Dhaka");

before(async () => {
  ctx = await setup();
  ana = await signUp(ctx.app, "Ana");
  ben = await signUp(ctx.app, "Ben");
  const org = await ana.agent.post("/api/workspaces").send({ name: "Acme Ltd", description: "" });
  orgId = org.body.id;
});
after(async () => {
  await ctx.teardown();
});
beforeEach(async () => {
  await q(`delete from habits`);
  await q(`delete from focus_sessions`);
  await q(`delete from notes`);
  await q(`delete from tasks`);
});

describe("streak maths", () => {
  const all = { byWeekday: [0, 1, 2, 3, 4, 5, 6], targetPerDay: 1, startDate: "2026-01-01" };
  const logs = (days: string[]) => new Map(days.map((d) => [d, 1]));
  it("counts consecutive days and does not punish a day that is still in progress", () => {
    const t = "2026-03-10";
    assert.deepEqual(computeStreaks(all, logs(["2026-03-09", "2026-03-08", "2026-03-07"]), t), { current: 3, longest: 3 });
    assert.equal(computeStreaks(all, logs(["2026-03-10", "2026-03-09"]), t).current, 2);
  });
  it("breaks on a missed scheduled day but skips days the habit does not apply to", () => {
    const t = "2026-03-10"; // Tuesday
    assert.equal(computeStreaks(all, logs(["2026-03-08", "2026-03-07"]), t).current, 0);
    const weekdays = { ...all, byWeekday: [1, 2, 3, 4, 5] };
    // Fri 6th, Mon 9th and Tue 10th done; the weekend in between is not scheduled.
    assert.equal(computeStreaks(weekdays, logs(["2026-03-06", "2026-03-09", "2026-03-10"]), t).current, 3);
  });
  it("remembers the longest run", () => {
    const l = logs(["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-06"]);
    assert.deepEqual(computeStreaks(all, l, "2026-03-07"), { current: 1, longest: 4 });
  });
});

describe("habits", () => {
  it("creates, logs and un-logs a habit, tracking the streak", async () => {
    const created = await ana.agent.post(`/api/workspaces/${ana.personalId}/habits`).send({ name: "Read", byWeekday: [0, 1, 2, 3, 4, 5, 6], targetPerDay: 1 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;
    assert.equal(created.body.dueToday, true);
    const logged = await ana.agent.put(`/api/habits/${id}/log`).send({ date: today(), count: 1 });
    assert.equal(logged.body.currentStreak, 1);
    assert.equal(logged.body.todayCount, 1);
    const undone = await ana.agent.put(`/api/habits/${id}/log`).send({ date: today(), count: 0 });
    assert.equal(undone.body.todayCount, 0);
    const list = await ana.agent.get(`/api/workspaces/${ana.personalId}/habits`);
    assert.equal(list.body.length, 1);
  });
  it("refuses future days and other people's habits", async () => {
    const h = (await ana.agent.post(`/api/workspaces/${ana.personalId}/habits`).send({ name: "Walk", byWeekday: [1], targetPerDay: 1 })).body;
    assert.equal((await ana.agent.put(`/api/habits/${h.id}/log`).send({ date: addDays(today(), 2), count: 1 })).status, 400);
    assert.equal((await ben.agent.put(`/api/habits/${h.id}/log`).send({ date: today(), count: 1 })).status, 404);
    assert.equal((await ben.agent.delete(`/api/habits/${h.id}`)).status, 404);
    assert.equal((await ben.agent.get(`/api/workspaces/${ana.personalId}/habits`)).status, 404);
  });
  it("validates input", async () => {
    const bad = await ana.agent.post(`/api/workspaces/${ana.personalId}/habits`).send({ name: "", byWeekday: [] });
    assert.equal(bad.status, 422);
  });
});

describe("focus sessions", () => {
  it("runs a session on a task and records the time on it", async () => {
    const task = (await ana.agent.post("/api/tasks").send({ workspaceId: ana.personalId, title: "Write spec" })).body;
    const start = await ana.agent.post("/api/focus").send({ taskId: task.id, kind: "focus", plannedMinutes: 25 });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    assert.equal((await ana.agent.get("/api/focus")).body.active.id, start.body.id);
    // Pretend the session began 25 minutes ago so the server-side clock cap allows it.
    await q(`update focus_sessions set started_at = now() - interval '25 minutes' where id = $1`, [start.body.id]);
    const done = await ana.agent.post(`/api/focus/${start.body.id}/finish`).send({ actualSeconds: 1500, completed: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.actualSeconds, 1500);
    const t = await q(`select actual_minutes from tasks where id = $1`, [task.id]);
    assert.equal(t.rows[0].actual_minutes, 25);
    const sum = (await ana.agent.get("/api/focus")).body;
    assert.equal(sum.active, null);
    assert.equal(sum.todayFocusMinutes, 25);
    assert.equal(sum.todaySessions, 1);
  });
  it("caps claimed time at what the server clock allows, and cannot be finished twice", async () => {
    const s = (await ana.agent.post("/api/focus").send({ kind: "focus", plannedMinutes: 25, workspaceId: ana.personalId })).body;
    const done = await ana.agent.post(`/api/focus/${s.id}/finish`).send({ actualSeconds: 1500, completed: true });
    assert.ok(done.body.actualSeconds <= 5, `claimed ${done.body.actualSeconds}s a moment after starting`);
    assert.equal((await ana.agent.post(`/api/focus/${s.id}/finish`).send({ actualSeconds: 10, completed: false })).status, 404);
  });
  it("closes a forgotten session when a new one starts, and keeps sessions private", async () => {
    const a = (await ana.agent.post("/api/focus").send({ kind: "focus", plannedMinutes: 25, workspaceId: ana.personalId })).body;
    const b = (await ana.agent.post("/api/focus").send({ kind: "short_break", plannedMinutes: 5 })).body;
    const rows = await q(`select id, ended_at from focus_sessions order by started_at`);
    assert.equal(rows.rows.find((r) => r.id === a.id).ended_at !== null, true);
    assert.equal((await ana.agent.get("/api/focus")).body.active.id, b.id);
    assert.equal((await ben.agent.get("/api/focus")).body.active, null);
    assert.equal((await ben.agent.post(`/api/focus/${b.id}/finish`).send({ actualSeconds: 1, completed: false })).status, 404);
  });
  it("refuses a task or workspace the caller cannot see", async () => {
    const task = (await ana.agent.post("/api/tasks").send({ workspaceId: ana.personalId, title: "Secret" })).body;
    assert.equal((await ben.agent.post("/api/focus").send({ taskId: task.id, plannedMinutes: 25 })).status, 404);
    assert.equal((await ben.agent.post("/api/focus").send({ workspaceId: ana.personalId, plannedMinutes: 25 })).status, 404);
    assert.equal((await ana.agent.post("/api/focus").send({ plannedMinutes: 0 })).status, 422);
  });
});

describe("notes", () => {
  it("creates, searches, edits and deletes notes", async () => {
    const n = await ana.agent.post(`/api/workspaces/${ana.personalId}/notes`).send({ title: "Ideas", body: "Learn Rust this year", kind: "personal" });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    assert.equal((await ana.agent.get(`/api/workspaces/${ana.personalId}/notes?q=rust`)).body.length, 1);
    assert.equal((await ana.agent.get(`/api/workspaces/${ana.personalId}/notes?q=100%25`)).body.length, 0);
    const edited = await ana.agent.patch(`/api/notes/${n.body.id}`).send({ title: "Ideas", body: "Learn Go", kind: "personal", visibility: "private" });
    assert.equal(edited.body.body, "Learn Go");
    assert.equal((await ana.agent.delete(`/api/notes/${n.body.id}`)).status, 200);
    assert.equal((await ana.agent.get(`/api/workspaces/${ana.personalId}/notes`)).body.length, 0);
  });
  it("rejects empty notes", async () => {
    assert.equal((await ana.agent.post(`/api/workspaces/${ana.personalId}/notes`).send({ body: "  " })).status, 422);
  });
  it("keeps private notes to the author and shares workspace notes with members only", async () => {
    await ana.agent.post(`/api/workspaces/${orgId}/invitations`).send({ email: ben.email, role: "member" });
    await ben.agent.post("/api/invitations/accept").send({ token: lastInviteToken() });
    const priv = (await ana.agent.post(`/api/workspaces/${orgId}/notes`).send({ body: "private thought", visibility: "private" })).body;
    await ana.agent.post(`/api/workspaces/${orgId}/notes`).send({ body: "meeting minutes", kind: "meeting", visibility: "workspace" });
    const seen = (await ben.agent.get(`/api/workspaces/${orgId}/notes`)).body as { body: string; mine: boolean }[];
    assert.deepEqual(seen.map((x) => x.body), ["meeting minutes"]);
    assert.equal(seen[0]!.mine, false);
    assert.equal((await ben.agent.patch(`/api/notes/${priv.id}`).send({ body: "hacked", kind: "quick", visibility: "workspace" })).status, 404);
    assert.equal((await ben.agent.delete(`/api/notes/${priv.id}`)).status, 404);
    // Personal notes are invisible to everyone else, including org admins.
    await ana.agent.post(`/api/workspaces/${ana.personalId}/notes`).send({ body: "diary" });
    assert.equal((await ben.agent.get(`/api/workspaces/${ana.personalId}/notes`)).status, 404);
  });
  it("converts a note into a task for its author and links them", async () => {
    const n = (await ana.agent.post(`/api/workspaces/${ana.personalId}/notes`).send({ body: "Book dentist\nbefore June" })).body;
    const conv = await ana.agent.post(`/api/notes/${n.id}/convert`);
    assert.equal(conv.status, 201, JSON.stringify(conv.body));
    const task = (await ana.agent.get(`/api/tasks/${conv.body.taskId}`)).body;
    assert.equal(task.title, "Book dentist");
    assert.equal(task.assignees.length, 1);
    const note = (await ana.agent.get(`/api/workspaces/${ana.personalId}/notes`)).body[0];
    assert.equal(note.taskId, conv.body.taskId);
    assert.equal((await ben.agent.post(`/api/notes/${n.id}/convert`)).status, 404);
  });
});

describe("analytics", () => {
  it("summarises completed work, overdue share, focus time and habits from real records", async () => {
    const done = (await ana.agent.post("/api/tasks").send({ workspaceId: ana.personalId, title: "Done thing" })).body;
    await ana.agent.patch(`/api/tasks/${done.id}`).send({ status: "completed" });
    await ana.agent.post("/api/tasks").send({ workspaceId: ana.personalId, title: "Late", dueDate: addDays(today(), -2) });
    await ana.agent.post("/api/tasks").send({ workspaceId: ana.personalId, title: "Fine", dueDate: addDays(today(), 3) });
    const s = (await ana.agent.post("/api/focus").send({ kind: "focus", plannedMinutes: 30, workspaceId: ana.personalId })).body;
    await q(`update focus_sessions set started_at = now() - interval '30 minutes' where id = $1`, [s.id]);
    await ana.agent.post(`/api/focus/${s.id}/finish`).send({ actualSeconds: 1800, completed: true });
    const h = (await ana.agent.post(`/api/workspaces/${ana.personalId}/habits`).send({ name: "Stretch", byWeekday: [0, 1, 2, 3, 4, 5, 6], targetPerDay: 1 })).body;
    await ana.agent.put(`/api/habits/${h.id}/log`).send({ date: today(), count: 1 });

    const res = await ana.agent.get("/api/analytics?days=7");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const a = res.body;
    assert.equal(a.daily.length, 7);
    assert.equal(a.daily.at(-1).date, today());
    assert.equal(a.totals.completed, 1);
    assert.equal(a.totals.pending, 2);
    assert.equal(a.totals.overdue, 1);
    assert.equal(a.totals.overduePercent, 50);
    assert.equal(a.totals.focusMinutes, 30);
    assert.equal(a.daily.at(-1).completed, 1);
    assert.equal(a.distribution.personal.completed, 1);
    assert.equal(a.distribution.work.completed, 0);
    assert.equal(a.habits.doneDays, 1);
    assert.equal(a.weekdays.reduce((n: number, w: { completed: number }) => n + w.completed, 0), 1);
  });
  it("never counts other people's tasks, and counts organization work only when assigned", async () => {
    await ben.agent.post("/api/tasks").send({ workspaceId: ben.personalId, title: "Ben private" });
    const orgTask = (await ana.agent.post("/api/tasks").send({ workspaceId: orgId, title: "Org task" })).body;
    await ana.agent.patch(`/api/tasks/${orgTask.id}`).send({ status: "completed" });
    const b = (await ben.agent.get("/api/analytics?days=30")).body;
    assert.equal(b.totals.pending, 1);
    assert.equal(b.totals.completed, 0);
    const a = (await ana.agent.get("/api/analytics?days=30")).body;
    assert.equal(a.distribution.work.completed, 1);
    assert.equal(a.distribution.personal.completed, 0);
    assert.equal((await ana.agent.get(`/api/analytics?workspaceId=${ben.personalId}`)).status, 404);
    assert.equal((await ana.agent.get("/api/analytics?days=5")).status, 422);
  });
});
