import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { lastInviteToken, setup, signUp, type TestUser } from "./helpers";

let ctx: Awaited<ReturnType<typeof setup>>;
let owner: TestUser;
let member: TestUser;
let stranger: TestUser;
let orgId: string;

before(async () => {
  ctx = await setup();
  owner = await signUp(ctx.app, "Owner");
  member = await signUp(ctx.app, "Member");
  stranger = await signUp(ctx.app, "Stranger");
  const org = await owner.agent.post("/api/workspaces").send({ name: "Acme Ltd" });
  orgId = org.body.id;
  await owner.agent.post(`/api/workspaces/${orgId}/invitations`).send({ email: member.email, role: "member" });
  const ok = await member.agent.post("/api/invitations/accept").send({ token: lastInviteToken() });
  assert.equal(ok.status, 200);
});

after(async () => {
  await ctx.teardown();
});

describe("task editing", () => {
  let taskId: string;

  it("creates a task with every field and reads it back", async () => {
    const res = await owner.agent.post("/api/tasks").send({
      workspaceId: owner.personalId,
      title: "Plan week",
      description: "Outline the week",
      notes: "Remember the dentist",
      priority: "high",
      startDate: "2026-12-01",
      dueDate: "2026-12-03",
      dueTime: "10:30",
      estimatedMinutes: 45,
      tags: ["Planning", "planning", "weekly"],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    taskId = res.body.id;
    assert.deepEqual(res.body.tags, ["planning", "weekly"]);
    const detail = await owner.agent.get(`/api/tasks/${taskId}`);
    assert.equal(detail.body.description, "Outline the week");
    assert.equal(detail.body.startDate, "2026-12-01");
    assert.equal(detail.body.dueTime, "10:30");
    assert.equal(detail.body.assignees.length, 1);
  });

  it("updates some fields and leaves the rest alone", async () => {
    const res = await owner.agent.patch(`/api/tasks/${taskId}`).send({ title: "Plan next week", priority: "urgent" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.title, "Plan next week");
    assert.equal(res.body.dueDate, "2026-12-03");
    assert.equal(res.body.notes, "Remember the dentist");
  });

  it("clearing the due date also clears the due time", async () => {
    const res = await owner.agent.patch(`/api/tasks/${taskId}`).send({ startDate: null, dueDate: null });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.dueDate, null);
    assert.equal(res.body.dueTime, null);
  });

  it("rejects a start date after the due date, using the merged values", async () => {
    await owner.agent.patch(`/api/tasks/${taskId}`).send({ dueDate: "2026-12-03" });
    const res = await owner.agent.patch(`/api/tasks/${taskId}`).send({ startDate: "2026-12-09" });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.dueDate);
  });

  it("completing sets completed_at and reopening clears it", async () => {
    const done = await owner.agent.patch(`/api/tasks/${taskId}`).send({ status: "completed" });
    assert.ok(done.body.completedAt);
    const again = await owner.agent.patch(`/api/tasks/${taskId}`).send({ status: "todo" });
    assert.equal(again.body.completedAt, null);
  });

  it("manages a checklist and reports progress", async () => {
    const a = await owner.agent.post(`/api/tasks/${taskId}/subtasks`).send({ title: "Draft" });
    await owner.agent.post(`/api/tasks/${taskId}/subtasks`).send({ title: "Review" });
    assert.equal(a.status, 201);
    const done = await owner.agent.patch(`/api/tasks/${taskId}/subtasks/${a.body.id}`).send({ isDone: true });
    assert.equal(done.body.isDone, true);
    const list = await owner.agent.get(`/api/tasks?workspaceId=${owner.personalId}`);
    const item = list.body.find((t: { id: string }) => t.id === taskId);
    assert.equal(item.subtasksTotal, 2);
    assert.equal(item.subtasksDone, 1);
    const del = await owner.agent.delete(`/api/tasks/${taskId}/subtasks/${a.body.id}`);
    assert.equal(del.status, 200);
  });

  it("duplicates a task with its checklist, reset to to-do", async () => {
    await owner.agent.patch(`/api/tasks/${taskId}`).send({ status: "completed" });
    const copy = await owner.agent.post(`/api/tasks/${taskId}/duplicate`);
    assert.equal(copy.status, 201, JSON.stringify(copy.body));
    assert.equal(copy.body.status, "todo");
    assert.match(copy.body.title, /\(copy\)$/);
    assert.equal(copy.body.subtasksTotal, 1);
  });

  it("archives and restores, hiding archived tasks from the default list", async () => {
    await owner.agent.post(`/api/tasks/${taskId}/archive`);
    const normal = await owner.agent.get(`/api/tasks?workspaceId=${owner.personalId}`);
    assert.ok(!normal.body.some((t: { id: string }) => t.id === taskId));
    const archived = await owner.agent.get(`/api/tasks?workspaceId=${owner.personalId}&archived=true`);
    assert.ok(archived.body.some((t: { id: string }) => t.id === taskId));
    await owner.agent.post(`/api/tasks/${taskId}/unarchive`);
    const back = await owner.agent.get(`/api/tasks?workspaceId=${owner.personalId}`);
    assert.ok(back.body.some((t: { id: string }) => t.id === taskId));
  });

  it("filters by tag, priority and text, and sorts by title", async () => {
    await owner.agent.post("/api/tasks").send({ workspaceId: owner.personalId, title: "Alpha chore", priority: "low", tags: ["home"] });
    const byTag = await owner.agent.get(`/api/tasks?workspaceId=${owner.personalId}&tag=HOME`);
    assert.deepEqual(byTag.body.map((t: { title: string }) => t.title), ["Alpha chore"]);
    const sorted = await owner.agent.get(`/api/tasks?workspaceId=${owner.personalId}&sort=title`);
    const titles = sorted.body.map((t: { title: string }) => t.title.toLowerCase());
    assert.deepEqual(titles, [...titles].sort());
    const none = await owner.agent.get(`/api/tasks?workspaceId=${owner.personalId}&q=zzzz`);
    assert.equal(none.body.length, 0);
  });

  it("keeps other people's tasks invisible and immutable", async () => {
    assert.equal((await stranger.agent.get(`/api/tasks/${taskId}`)).status, 404);
    assert.equal((await stranger.agent.patch(`/api/tasks/${taskId}`).send({ title: "Hijack" })).status, 404);
    assert.equal((await stranger.agent.post(`/api/tasks/${taskId}/subtasks`).send({ title: "x" })).status, 404);
    assert.equal((await stranger.agent.post(`/api/tasks/${taskId}/duplicate`)).status, 404);
    assert.equal((await stranger.agent.post(`/api/tasks/${taskId}/archive`)).status, 404);
    const check = await owner.agent.get(`/api/tasks/${taskId}`);
    assert.equal(check.body.title, "Plan next week");
  });
});

describe("projects and categories", () => {
  let projectId: string;

  it("lets an admin create a project and shows progress", async () => {
    const res = await owner.agent
      .post(`/api/workspaces/${orgId}/projects`)
      .send({ name: "Launch", description: null, status: "active", color: "#2563eb", dueDate: null });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    projectId = res.body.id;
    const t = await owner.agent.post("/api/tasks").send({ workspaceId: orgId, title: "Ship it", projectId, status: "completed" });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    assert.equal(t.body.projectName, "Launch");
    const list = await owner.agent.get(`/api/workspaces/${orgId}/projects`);
    assert.equal(list.body[0].taskTotal, 1);
    assert.equal(list.body[0].taskDone, 1);
  });

  it("does not let a plain member manage projects or categories", async () => {
    const body = { name: "Mine", description: null, status: "active", color: "#2563eb", dueDate: null };
    assert.equal((await member.agent.post(`/api/workspaces/${orgId}/projects`).send(body)).status, 403);
    assert.equal((await member.agent.patch(`/api/projects/${projectId}`).send(body)).status, 404);
    assert.equal((await member.agent.post(`/api/workspaces/${orgId}/categories`).send({ name: "X", color: "#112233" })).status, 403);
    // but a member can see them
    assert.equal((await member.agent.get(`/api/workspaces/${orgId}/projects`)).status, 200);
  });

  it("hides a workspace's projects from non-members", async () => {
    assert.equal((await stranger.agent.get(`/api/workspaces/${orgId}/projects`)).status, 404);
  });

  it("refuses a project from another workspace on a task", async () => {
    const res = await owner.agent.post("/api/tasks").send({ workspaceId: owner.personalId, title: "Cross", projectId });
    assert.equal(res.status, 422, JSON.stringify(res.body));
  });

  it("deleting a project keeps its tasks", async () => {
    const del = await owner.agent.delete(`/api/projects/${projectId}`);
    assert.equal(del.status, 200);
    const tasks = await owner.agent.get(`/api/tasks?workspaceId=${orgId}`);
    assert.equal(tasks.body[0].projectId, null);
  });

  it("creates, renames and rejects duplicate categories", async () => {
    const c = await owner.agent.post(`/api/workspaces/${orgId}/categories`).send({ name: "Finance", color: "#0369a1" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const dup = await owner.agent.post(`/api/workspaces/${orgId}/categories`).send({ name: "Finance", color: "#0369a1" });
    assert.equal(dup.status, 409);
    const r = await owner.agent.patch(`/api/categories/${c.body.id}`).send({ name: "Money", color: "#0369a1" });
    assert.equal(r.body.name, "Money");
  });
});
