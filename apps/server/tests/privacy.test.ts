import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { withUser } from "../src/db/pool";
import { lastInviteToken, setup, signUp, type TestUser } from "./helpers";

let ctx: Awaited<ReturnType<typeof setup>>;
let owner: TestUser; // org admin, also has a personal workspace
let manager: TestUser;
let member: TestUser;
let outsider: TestUser;
let orgId: string;

async function invite(who: TestUser, role: "admin" | "manager" | "member") {
  const created = await owner.agent.post(`/api/workspaces/${orgId}/invitations`).send({ email: who.email, role });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const accepted = await who.agent.post("/api/invitations/accept").send({ token: lastInviteToken() });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
}

before(async () => {
  ctx = await setup();
  owner = await signUp(ctx.app, "Owner");
  manager = await signUp(ctx.app, "Manager");
  member = await signUp(ctx.app, "Member");
  outsider = await signUp(ctx.app, "Outsider");

  const org = await owner.agent.post("/api/workspaces").send({ name: "Acme Ltd", description: "" });
  assert.equal(org.status, 201, JSON.stringify(org.body));
  orgId = org.body.id;
  await invite(manager, "manager");
  await invite(member, "member");
});

after(async () => {
  await ctx.teardown();
});

describe("personal workspace privacy", () => {
  it("creates a personal workspace on registration with the owner as sole member", async () => {
    const me = await owner.agent.get("/api/me");
    const personal = me.body.workspaces.find((w: { type: string }) => w.type === "personal");
    assert.equal(personal.memberCount, 1);
    assert.equal(personal.role, "admin");
  });

  it("hides one user's personal workspace from everyone else, including org admins", async () => {
    const res = await owner.agent.get(`/api/workspaces/${member.personalId}`);
    assert.equal(res.status, 404);
    const members = await owner.agent.get(`/api/workspaces/${member.personalId}/members`);
    assert.equal(members.status, 404);
  });

  it("keeps personal tasks out of an org admin's task list and dashboards", async () => {
    const add = await member.agent.post("/api/tasks").send({
      workspaceId: member.personalId, title: "Secret doctor appointment", priority: "high",
      dueDate: null, dueTime: null, estimatedMinutes: null,
    });
    assert.equal(add.status, 201, JSON.stringify(add.body));

    for (const viewer of [owner, manager]) {
      const list = await viewer.agent.get("/api/tasks");
      assert.ok(!JSON.stringify(list.body).includes("Secret doctor"), "task leaked into list");
      const dash = await viewer.agent.get("/api/dashboard");
      assert.ok(!JSON.stringify(dash.body).includes("Secret doctor"), "task leaked into dashboard");
      const direct = await viewer.agent.get(`/api/tasks?workspaceId=${member.personalId}`);
      assert.deepEqual(direct.body, []);
    }
  });

  it("refuses writes into someone else's personal workspace", async () => {
    const res = await owner.agent.post("/api/tasks").send({
      workspaceId: member.personalId, title: "Planted", priority: "low",
      dueDate: null, dueTime: null, estimatedMinutes: null,
    });
    assert.equal(res.status, 404);
  });

  it("enforces isolation in the database itself, not just the API", async () => {
    // Even hand-written SQL as the org admin sees and changes nothing in a personal workspace.
    await withUser(owner.id, async (db) => {
      const seen = await db.query(`select count(*)::int as n from tasks where workspace_id = $1`, [member.personalId]);
      assert.equal(seen.rows[0].n, 0);
      const upd = await db.query(`update tasks set title = 'hacked' where workspace_id = $1`, [member.personalId]);
      assert.equal(upd.rowCount, 0);
      const del = await db.query(`delete from tasks where workspace_id = $1`, [member.personalId]);
      assert.equal(del.rowCount, 0);
      const mem = await db.query(`select count(*)::int as n from workspace_members where workspace_id = $1`, [member.personalId]);
      assert.equal(mem.rows[0].n, 0);
    });
    await assert.rejects(
      withUser(owner.id, (db) =>
        db.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')`, [member.personalId, owner.id]),
      ),
    );
  });

  it("cannot read accounts, sessions or auth tokens as a user", async () => {
    for (const table of ["users", "sessions", "auth_tokens"]) {
      await assert.rejects(withUser(owner.id, (db) => db.query(`select * from ${table}`)), /permission denied/);
    }
  });

  it("will not let a personal workspace be given extra members even by the system", async () => {
    await assert.rejects(
      ctx.pool.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')`, [
        owner.personalId, member.id,
      ]),
      /personal workspaces cannot have other members/,
    );
  });
});

describe("organization roles", () => {
  let taskId: string;

  it("lets an admin and manager see an org task, but a plain member only sees their own", async () => {
    const add = await owner.agent.post("/api/tasks").send({
      workspaceId: orgId, title: "Prepare quarterly report", priority: "urgent",
      dueDate: null, dueTime: null, estimatedMinutes: 90,
    });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    taskId = add.body.id;

    const asManager = await manager.agent.get(`/api/tasks?workspaceId=${orgId}`);
    assert.equal(asManager.body.length, 1);
    const asMember = await member.agent.get(`/api/tasks?workspaceId=${orgId}`);
    assert.equal(asMember.body.length, 0);
    const status = await member.agent.patch(`/api/tasks/${taskId}/status`).send({ status: "completed" });
    assert.equal(status.status, 404);
  });

  it("lets a member add their own org task and complete it", async () => {
    const add = await member.agent.post("/api/tasks").send({
      workspaceId: orgId, title: "Update my timesheet", priority: "medium",
      dueDate: null, dueTime: null, estimatedMinutes: null,
    });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    const done = await member.agent.patch(`/api/tasks/${add.body.id}/status`).send({ status: "completed" });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, "completed");
    assert.ok(done.body.completedAt);
  });

  it("restricts organization management to admins", async () => {
    const asManager = await manager.agent.post(`/api/workspaces/${orgId}/invitations`).send({ email: "x@example.com", role: "member" });
    assert.equal(asManager.status, 403);
    const asMember = await member.agent.patch(`/api/workspaces/${orgId}`).send({ name: "Mine now" });
    assert.equal(asMember.status, 403);
    const asOutsider = await outsider.agent.get(`/api/workspaces/${orgId}/members`);
    assert.equal(asOutsider.status, 404);
  });

  it("does not let a member promote themselves", async () => {
    const res = await member.agent.patch(`/api/workspaces/${orgId}/members/${member.id}`).send({ role: "admin" });
    assert.equal(res.status, 403);
  });

  it("keeps at least one admin", async () => {
    const leave = await owner.agent.delete(`/api/workspaces/${orgId}/members/${owner.id}`);
    assert.equal(leave.status, 409);
    const demote = await owner.agent.patch(`/api/workspaces/${orgId}/members/${owner.id}`).send({ role: "member" });
    assert.equal(demote.status, 409);
  });

  it("lets a member leave and drops their assignments", async () => {
    const leave = await member.agent.delete(`/api/workspaces/${orgId}/members/${member.id}`);
    assert.equal(leave.status, 200);
    const left = await ctx.pool.query(`select count(*)::int as n from task_assignees where user_id = $1 and workspace_id = $2`, [member.id, orgId]);
    assert.equal(left.rows[0].n, 0);
    const again = await member.agent.get(`/api/workspaces/${orgId}`);
    assert.equal(again.status, 404);
  });
});

describe("invitations", () => {
  it("only works for the invited email", async () => {
    await owner.agent.post(`/api/workspaces/${orgId}/invitations`).send({ email: outsider.email, role: "member" });
    const token = lastInviteToken();
    const other = await signUp(ctx.app, "Other");
    const res = await other.agent.post("/api/invitations/accept").send({ token });
    assert.equal(res.status, 404);
    const ok = await outsider.agent.post("/api/invitations/accept").send({ token });
    assert.equal(ok.status, 200);
    const reuse = await outsider.agent.post("/api/invitations/accept").send({ token });
    assert.equal(reuse.status, 404);
  });

  it("requires a verified email to accept by id", async () => {
    const fresh = await signUp(ctx.app, "Fresh");
    await owner.agent.post(`/api/workspaces/${orgId}/invitations`).send({ email: fresh.email, role: "member" });
    const mine = await fresh.agent.get("/api/invitations/mine");
    assert.deepEqual(mine.body, []); // unverified accounts see nothing
    const inv = await ctx.pool.query(`select id from workspace_invitations where email = $1`, [fresh.email]);
    const res = await fresh.agent.post("/api/invitations/accept").send({ invitationId: inv.rows[0].id });
    assert.equal(res.status, 403);
  });

  it("rejects duplicate pending invitations and existing members", async () => {
    const dup = await owner.agent.post(`/api/workspaces/${orgId}/invitations`).send({ email: "dup@example.com", role: "member" });
    assert.equal(dup.status, 201);
    const again = await owner.agent.post(`/api/workspaces/${orgId}/invitations`).send({ email: "dup@example.com", role: "member" });
    assert.equal(again.status, 409);
    const existing = await owner.agent.post(`/api/workspaces/${orgId}/invitations`).send({ email: manager.email, role: "member" });
    assert.equal(existing.status, 409);
  });
});
