import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { localDate } from "@lifesync/shared";
import { runSchedulerOnce } from "../src/services/scheduler";
import { lastInviteToken, outside, pushLog, sentMail, setup, signUp, type TestUser } from "./helpers";

let ctx: Awaited<ReturnType<typeof setup>>;
let owner: TestUser; // org admin
let manager: TestUser;
let ana: TestUser; // plain members
let ben: TestUser;
let outsider: TestUser;
let orgId: string;

const q = (sql: string, params: unknown[] = []) => ctx.pool.query(sql, params);
const inbox = async (u: TestUser) =>
  (await u.agent.get("/api/notifications")).body.items as { type: string; title: string; body: string; link: string; taskId: string }[];

async function join(who: TestUser, role: "admin" | "manager" | "member") {
  const created = await owner.agent.post(`/api/workspaces/${orgId}/invitations`).send({ email: who.email, role });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const accepted = await who.agent.post("/api/invitations/accept").send({ token: lastInviteToken() });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
}

/** A task created by `by` in the organization, optionally assigned to specific people. */
async function orgTask(by: TestUser, body: Record<string, unknown> = {}) {
  const res = await by.agent.post("/api/tasks").send({ workspaceId: orgId, title: "Prepare quarterly report", ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id as string;
}
const assigneeIds = (task: { assignees: { userId: string }[] }) => task.assignees.map((a) => a.userId).sort();

before(async () => {
  ctx = await setup();
  owner = await signUp(ctx.app, "Owner");
  manager = await signUp(ctx.app, "Manager");
  ana = await signUp(ctx.app, "Ana");
  ben = await signUp(ctx.app, "Ben");
  outsider = await signUp(ctx.app, "Outsider");
  const org = await owner.agent.post("/api/workspaces").send({ name: "Acme Ltd", description: "" });
  assert.equal(org.status, 201, JSON.stringify(org.body));
  orgId = org.body.id;
  await join(manager, "manager");
  await join(ana, "member");
  await join(ben, "member");
});
after(async () => {
  await ctx.teardown();
});
beforeEach(async () => {
  outside.push = "ok";
  outside.mail = "ok";
  pushLog.length = 0;
  sentMail.length = 0;
  await q(`delete from tasks`);
  await q(`delete from notifications`);
  await q(`delete from activity_logs`);
  await q(`delete from push_subscriptions`);
  await q(`update user_notification_preferences set in_app_enabled = true, push_enabled = true, email_enabled = false,
           quiet_hours_enabled = false, missed_reminder_alerts = false, default_reminder_offsets = '{}'`);
});

describe("assigning tasks", () => {
  it("lets a manager create a task for other people, without auto-assigning themselves", async () => {
    const id = await orgTask(manager, { assigneeIds: [ana.id, ben.id] });
    const task = (await manager.agent.get(`/api/tasks/${id}`)).body;
    assert.deepEqual(assigneeIds(task), [ana.id, ben.id].sort());
    assert.equal(task.permissions.assign, true);
  });

  it("still makes the creator the assignee when nobody is chosen", async () => {
    const id = await orgTask(ana);
    assert.deepEqual(assigneeIds((await ana.agent.get(`/api/tasks/${id}`)).body), [ana.id]);
  });

  it("refuses a plain member who tries to assign a task to somebody else", async () => {
    const res = await ana.agent.post("/api/tasks").send({ workspaceId: orgId, title: "Delegate", assigneeIds: [ben.id] });
    assert.equal(res.status, 403);
    const own = await orgTask(ana);
    const put = await ana.agent.put(`/api/tasks/${own}/assignees`).send({ userIds: [ben.id] });
    assert.equal(put.status, 403);
    assert.deepEqual(assigneeIds((await ana.agent.get(`/api/tasks/${own}`)).body), [ana.id]);
  });

  it("refuses to assign somebody who is not a member of the workspace", async () => {
    const id = await orgTask(manager);
    const res = await manager.agent.put(`/api/tasks/${id}/assignees`).send({ userIds: [outsider.id] });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    const create = await manager.agent.post("/api/tasks").send({ workspaceId: orgId, title: "X", assigneeIds: [outsider.id] });
    assert.equal(create.status, 422);
  });

  it("adds and removes people, and returns the updated task", async () => {
    const id = await orgTask(manager, { assigneeIds: [ana.id] });
    const res = await manager.agent.put(`/api/tasks/${id}/assignees`).send({ userIds: [ben.id] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(assigneeIds(res.body), [ben.id]);
    assert.equal((await ana.agent.get(`/api/tasks/${id}`)).status, 404, "a plain member loses sight of a task they were taken off");
    assert.equal((await ben.agent.get(`/api/tasks/${id}`)).status, 200);
  });

  it("notifies the people who were assigned, but not the manager who assigned them", async () => {
    const id = await orgTask(manager, { assigneeIds: [ana.id] });
    const mine = await inbox(ana);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.type, "assigned");
    assert.match(mine[0]!.title, /Manager assigned you a task/);
    assert.equal(mine[0]!.body, "Prepare quarterly report");
    assert.equal(mine[0]!.taskId, id);
    assert.equal((await inbox(manager)).length, 0);
    await manager.agent.put(`/api/tasks/${id}/assignees`).send({ userIds: [ana.id, ben.id] });
    assert.equal((await inbox(ana)).length, 1, "people already assigned are not notified again");
    assert.equal((await inbox(ben)).length, 1);
  });

  it("sends assignment notifications over push too, without reminder buttons", async () => {
    await ana.agent.post("/api/push/subscribe").send({ endpoint: "https://push.example/ana", keys: { p256dh: "p".repeat(20), auth: "a".repeat(20) } });
    await orgTask(manager, { assigneeIds: [ana.id] });
    await runSchedulerOnce(ctx.deps, new Date());
    assert.equal(pushLog.length, 1);
    assert.match(pushLog[0]!.payload.tag ?? "", /^note-/, "only reminders get the Mark done / Snooze buttons");
  });

  it("cancels the pending reminders of somebody taken off a task", async () => {
    const date = localDate(Date.now() + 5 * 86_400_000, "Asia/Dhaka");
    const id = await orgTask(manager, { assigneeIds: [ana.id], dueDate: date, dueTime: "10:00" });
    assert.equal((await ana.agent.put(`/api/tasks/${id}/reminders`).send({ offsets: [15], custom: [] })).status, 200);
    assert.equal((await q(`select count(*)::int as n from task_reminders where user_id = $1 and status = 'pending'`, [ana.id])).rows[0].n, 1);
    await manager.agent.put(`/api/tasks/${id}/assignees`).send({ userIds: [ben.id] });
    assert.equal((await q(`select count(*)::int as n from task_reminders where user_id = $1 and status = 'pending'`, [ana.id])).rows[0].n, 0);
  });

  it("filters the task list by assignee", async () => {
    await orgTask(manager, { title: "For Ana", assigneeIds: [ana.id] });
    await orgTask(manager, { title: "For Ben", assigneeIds: [ben.id] });
    await orgTask(manager, { title: "For nobody", assigneeIds: [] });
    const titles = async (assignee: string) =>
      ((await manager.agent.get(`/api/tasks?workspaceId=${orgId}&assignee=${assignee}`)).body as { title: string }[]).map((t) => t.title);
    assert.deepEqual(await titles(ana.id), ["For Ana"]);
    assert.deepEqual(await titles("none"), ["For nobody"]);
    assert.deepEqual(await titles("me"), []);
    assert.equal((await manager.agent.get(`/api/tasks?workspaceId=${orgId}&assignee=not-a-user`)).status, 422);
  });

  it("shows assignees on list items", async () => {
    await orgTask(manager, { assigneeIds: [ana.id, ben.id] });
    const list = (await manager.agent.get(`/api/tasks?workspaceId=${orgId}`)).body;
    assert.deepEqual(assigneeIds(list[0]), [ana.id, ben.id].sort());
    assert.ok(list[0].assignees[0].fullName);
  });
});

describe("role-based task permissions", () => {
  it("lets an assignee move work forward: status, notes and time spent", async () => {
    const id = await orgTask(manager, { assigneeIds: [ana.id] });
    const res = await ana.agent.patch(`/api/tasks/${id}`).send({ status: "in_progress", notes: "Started on the numbers", actualMinutes: 30 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "in_progress");
    assert.equal(res.body.permissions.edit, false);
    assert.equal((await ana.agent.patch(`/api/tasks/${id}/status`).send({ status: "completed" })).status, 200);
  });

  it("stops an assignee reshaping the task: title, schedule, priority, project, tags, repeat", async () => {
    const id = await orgTask(manager, { assigneeIds: [ana.id], dueDate: "2030-01-10" });
    for (const change of [{ title: "Hijacked" }, { dueDate: "2030-02-01" }, { priority: "urgent" }, { tags: ["x"] }, { description: "new" }, { estimatedMinutes: 5 }]) {
      const res = await ana.agent.patch(`/api/tasks/${id}`).send(change);
      assert.equal(res.status, 403, `${JSON.stringify(change)} should be refused`);
    }
    const task = (await manager.agent.get(`/api/tasks/${id}`)).body;
    assert.equal(task.title, "Prepare quarterly report");
    assert.equal(task.dueDate, "2030-01-10");
  });

  it("accepts the whole edit form from an assignee as long as only allowed fields changed", async () => {
    const id = await orgTask(manager, { assigneeIds: [ana.id], dueDate: "2030-01-10", priority: "high", tags: ["q4"] });
    const current = (await ana.agent.get(`/api/tasks/${id}`)).body;
    const res = await ana.agent.patch(`/api/tasks/${id}`).send({
      title: current.title, priority: current.priority, dueDate: current.dueDate, tags: current.tags, status: "in_progress", notes: "ok",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it("stops an assignee archiving or deleting the task, but lets the creator and managers", async () => {
    const id = await orgTask(manager, { assigneeIds: [ana.id] });
    assert.equal((await ana.agent.post(`/api/tasks/${id}/archive`).send({})).status, 403);
    assert.equal((await ana.agent.delete(`/api/tasks/${id}`)).status, 403);
    assert.equal((await manager.agent.post(`/api/tasks/${id}/archive`).send({})).status, 200);
    assert.equal((await manager.agent.delete(`/api/tasks/${id}`)).status, 200);
  });

  it("gives people full control over tasks they created themselves", async () => {
    const id = await orgTask(ana);
    const res = await ana.agent.patch(`/api/tasks/${id}`).send({ title: "Renamed", priority: "urgent" });
    assert.equal(res.status, 200);
    assert.equal(res.body.permissions.edit, true);
    assert.equal(res.body.permissions.assign, false, "only managers choose assignees");
    assert.equal((await ana.agent.delete(`/api/tasks/${id}`)).status, 200);
  });

  it("hides tasks from members who are neither the creator nor an assignee", async () => {
    const id = await orgTask(manager, { assigneeIds: [ana.id] });
    assert.equal((await ben.agent.get(`/api/tasks/${id}`)).status, 404);
    assert.equal((await ben.agent.get(`/api/tasks/${id}/comments`)).status, 404);
    assert.equal((await ben.agent.get(`/api/tasks/${id}/activity`)).status, 404);
    assert.equal((await ben.agent.post(`/api/tasks/${id}/comments`).send({ body: "hi" })).status, 404);
    assert.equal((await outsider.agent.get(`/api/tasks/${id}`)).status, 404);
  });

  it("gives managers and admins full control of every task", async () => {
    const id = await orgTask(ana);
    assert.equal((await manager.agent.patch(`/api/tasks/${id}`).send({ title: "Reworded by manager" })).status, 200);
    assert.equal((await owner.agent.patch(`/api/tasks/${id}`).send({ priority: "low" })).status, 200);
  });
});

describe("comments", () => {
  async function shared() {
    const id = await orgTask(manager, { assigneeIds: [ana.id] });
    await q(`delete from notifications`);
    return id;
  }

  it("lets people who can see the task discuss it, newest last", async () => {
    const id = await shared();
    const first = await ana.agent.post(`/api/tasks/${id}/comments`).send({ body: "  Draft is ready  " });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.body, "Draft is ready");
    assert.equal(first.body.author.fullName, "Ana");
    assert.equal(first.body.canEdit, true);
    await manager.agent.post(`/api/tasks/${id}/comments`).send({ body: "Thanks, reviewing" });
    const list = (await ana.agent.get(`/api/tasks/${id}/comments`)).body;
    assert.deepEqual(list.map((c: { body: string }) => c.body), ["Draft is ready", "Thanks, reviewing"]);
    assert.deepEqual(list.map((c: { canEdit: boolean }) => c.canEdit), [true, false]);
  });

  it("rejects empty and oversized comments", async () => {
    const id = await shared();
    assert.equal((await ana.agent.post(`/api/tasks/${id}/comments`).send({ body: "   " })).status, 422);
    assert.equal((await ana.agent.post(`/api/tasks/${id}/comments`).send({ body: "x".repeat(5001) })).status, 422);
  });

  it("notifies the assignees and the creator, never the author", async () => {
    const id = await shared();
    await ana.agent.post(`/api/tasks/${id}/comments`).send({ body: "Question about the figures" });
    const mgr = await inbox(manager); // the creator
    assert.equal(mgr.length, 1);
    assert.equal(mgr[0]!.type, "comment");
    assert.match(mgr[0]!.title, /Ana commented on "Prepare quarterly report"/);
    assert.equal(mgr[0]!.body, "Question about the figures");
    assert.equal((await inbox(ana)).length, 0, "the author is not notified of their own comment");
    assert.equal((await inbox(ben)).length, 0, "people outside the task are not told");
    await manager.agent.post(`/api/tasks/${id}/comments`).send({ body: "Answered" });
    assert.equal((await inbox(ana)).length, 1);
  });

  it("lets authors edit their own comments only", async () => {
    const id = await shared();
    const c = (await ana.agent.post(`/api/tasks/${id}/comments`).send({ body: "Typo" })).body;
    const edited = await ana.agent.patch(`/api/tasks/${id}/comments/${c.id}`).send({ body: "Fixed" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.body, "Fixed");
    assert.ok(edited.body.editedAt);
    assert.equal((await manager.agent.patch(`/api/tasks/${id}/comments/${c.id}`).send({ body: "Rewritten" })).status, 403);
    assert.equal((await ana.agent.patch(`/api/tasks/${id}/comments/00000000-0000-4000-8000-000000000000`).send({ body: "x" })).status, 404);
  });

  it("lets authors and admins delete comments, but not other members or managers", async () => {
    const id = await shared();
    const byAna = (await ana.agent.post(`/api/tasks/${id}/comments`).send({ body: "Mine" })).body;
    const byMgr = (await manager.agent.post(`/api/tasks/${id}/comments`).send({ body: "Manager note" })).body;
    assert.equal((await ana.agent.delete(`/api/tasks/${id}/comments/${byMgr.id}`)).status, 403);
    assert.equal((await manager.agent.delete(`/api/tasks/${id}/comments/${byAna.id}`)).status, 403, "managers cannot erase somebody else's words");
    assert.equal((await owner.agent.delete(`/api/tasks/${id}/comments/${byAna.id}`)).status, 200, "admins moderate");
    assert.equal((await manager.agent.delete(`/api/tasks/${id}/comments/${byMgr.id}`)).status, 200);
    assert.equal((await ana.agent.get(`/api/tasks/${id}/comments`)).body.length, 0);
  });

  it("sends comment notifications over push without reminder buttons", async () => {
    const id = await shared();
    await manager.agent.post("/api/push/subscribe").send({ endpoint: "https://push.example/mgr", keys: { p256dh: "p".repeat(20), auth: "a".repeat(20) } });
    await ana.agent.post(`/api/tasks/${id}/comments`).send({ body: "ping" });
    await runSchedulerOnce(ctx.deps, new Date());
    assert.equal(pushLog.length, 1);
    assert.match(pushLog[0]!.payload.tag ?? "", /^note-/);
  });

  it("removes comments together with their task", async () => {
    const id = await shared();
    await ana.agent.post(`/api/tasks/${id}/comments`).send({ body: "bye" });
    await manager.agent.delete(`/api/tasks/${id}`);
    assert.equal((await q(`select count(*)::int as n from task_comments`)).rows[0].n, 0);
  });
});

describe("activity timeline", () => {
  it("records who did what on a task, newest first, readable by anyone who can see it", async () => {
    const id = await orgTask(manager, { assigneeIds: [ana.id] });
    await ana.agent.patch(`/api/tasks/${id}`).send({ status: "in_progress" });
    await manager.agent.patch(`/api/tasks/${id}`).send({ priority: "urgent", title: "Prepare Q4 report" });
    await ana.agent.post(`/api/tasks/${id}/comments`).send({ body: "hello" });
    const res = await ana.agent.get(`/api/tasks/${id}/activity`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const actions = res.body.map((e: { action: string }) => e.action);
    assert.deepEqual(actions, ["task.commented", "task.updated", "task.status_changed", "task.assigned", "task.created"]);
    const updated = res.body.find((e: { action: string }) => e.action === "task.updated");
    assert.deepEqual(updated.metadata.fields.sort(), ["priority", "title"]);
    assert.equal(updated.actor.fullName, "Manager");
    const status = res.body.find((e: { action: string }) => e.action === "task.status_changed");
    assert.equal(status.metadata.status, "in_progress");
    assert.equal(status.metadata.from, "todo");
    const assigned = res.body.find((e: { action: string }) => e.action === "task.assigned");
    assert.equal(assigned.metadata.name, "Ana");
  });

  it("does not log an update when nothing actually changed", async () => {
    const id = await orgTask(manager, { assigneeIds: [ana.id] });
    await manager.agent.patch(`/api/tasks/${id}`).send({ title: "Prepare quarterly report", priority: "medium" });
    const actions = (await manager.agent.get(`/api/tasks/${id}/activity`)).body.map((e: { action: string }) => e.action);
    assert.ok(!actions.includes("task.updated"));
  });

  it("keeps the workspace feed for managers and admins, including deleted tasks by title", async () => {
    const id = await orgTask(ana, { title: "Throwaway" });
    await ana.agent.delete(`/api/tasks/${id}`);
    assert.equal((await ana.agent.get(`/api/workspaces/${orgId}/activity`)).status, 403);
    const feed = await manager.agent.get(`/api/workspaces/${orgId}/activity`);
    assert.equal(feed.status, 200);
    const deleted = feed.body.find((e: { action: string }) => e.action === "task.deleted");
    assert.equal(deleted.taskTitle, "Throwaway");
    assert.equal(deleted.actor.fullName, "Ana");
    assert.equal((await outsider.agent.get(`/api/workspaces/${orgId}/activity`)).status, 404);
  });

  it("pages through the feed with before", async () => {
    for (let i = 0; i < 3; i++) await orgTask(manager, { title: `Task ${i}` });
    const first = (await manager.agent.get(`/api/workspaces/${orgId}/activity?limit=2`)).body;
    assert.equal(first.length, 2);
    const next = (await manager.agent.get(`/api/workspaces/${orgId}/activity?limit=2&before=${encodeURIComponent(first[1].createdAt)}`)).body;
    assert.ok(next.every((e: { createdAt: string }) => e.createdAt < first[1].createdAt));
  });
});

describe("team overview", () => {
  it("shows each member's workload to managers and admins", async () => {
    const today = localDate(Date.now(), "Asia/Dhaka");
    const yesterday = localDate(Date.now() - 86_400_000, "Asia/Dhaka");
    await orgTask(manager, { title: "A", assigneeIds: [ana.id], dueDate: today });
    await orgTask(manager, { title: "B", assigneeIds: [ana.id], dueDate: yesterday });
    const done = await orgTask(manager, { title: "C", assigneeIds: [ana.id] });
    await ana.agent.patch(`/api/tasks/${done}/status`).send({ status: "completed" });
    const busy = await orgTask(manager, { title: "D", assigneeIds: [ana.id, ben.id] });
    await ben.agent.patch(`/api/tasks/${busy}/status`).send({ status: "in_progress" });
    await orgTask(manager, { title: "Orphan", assigneeIds: [] });

    const res = await manager.agent.get(`/api/workspaces/${orgId}/team`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = (id: string) => res.body.members.find((m: { userId: string }) => m.userId === id);
    assert.deepEqual(
      { open: row(ana.id).open, dueToday: row(ana.id).dueToday, overdue: row(ana.id).overdue, done: row(ana.id).completedLast7Days },
      { open: 3, dueToday: 1, overdue: 1, done: 1 },
    );
    assert.equal(row(ben.id).open, 1);
    assert.equal(row(ben.id).inProgress, 1);
    assert.equal(row(manager.id).open, 0);
    assert.equal(res.body.unassignedOpen, 1);
    assert.deepEqual(res.body.totals, { open: 4, overdue: 1, completedLast7Days: 1 }, "a task shared by two people counts once");
    assert.equal(res.body.members.length, 4);
    assert.equal((await owner.agent.get(`/api/workspaces/${orgId}/team`)).status, 200);
  });

  it("is closed to plain members, outsiders and personal workspaces", async () => {
    assert.equal((await ana.agent.get(`/api/workspaces/${orgId}/team`)).status, 403);
    assert.equal((await outsider.agent.get(`/api/workspaces/${orgId}/team`)).status, 404);
    assert.equal((await owner.agent.get(`/api/workspaces/${owner.personalId}/team`)).status, 403);
  });
});
