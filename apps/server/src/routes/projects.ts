import { randomUUID } from "node:crypto";
import { Router } from "express";
import { categorySchema, projectSchema, uuidSchema, type Category, type Project } from "@lifesync/shared";
import { requireAuth, uid } from "../auth/sessions";
import type { AppContext } from "../context";
import { withUser, type Db } from "../db/pool";
import { conflict, handler, notFound, parse } from "../http";

const PROJECT_SQL = `
  p.id, p.workspace_id, p.name, p.description, p.status, p.color, p.due_date::text as due_date,
  (select count(*)::int from tasks t where t.project_id = p.id and t.archived_at is null and t.status <> 'cancelled') as task_total,
  (select count(*)::int from tasks t where t.project_id = p.id and t.archived_at is null and t.status = 'completed') as task_done`;

function mapProject(r: Record<string, any>): Project {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    description: r.description,
    status: r.status,
    color: r.color,
    dueDate: r.due_date,
    taskTotal: r.task_total,
    taskDone: r.task_done,
  };
}

/** Workspace membership gate: non-members get 404 because RLS hides the workspace from them. */
async function requireMember(db: Db, workspaceId: string) {
  const q = await db.query(`select 1 from workspace_members where workspace_id = $1 and user_id = app.current_user_id()`, [workspaceId]);
  if (!q.rows[0]) throw notFound("Workspace not found");
}

/** Writes are restricted to admins and managers by row-level security; zero affected rows then means "not allowed or missing". */
function duplicateName(e: unknown): never {
  if ((e as { code?: string }).code === "23505") throw conflict("That name is already used here", "duplicate_name");
  throw e;
}

export function projectsRouter(_ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth);

  // ---- Projects ----

  r.get(
    "/workspaces/:id/projects",
    handler(async (req, res) => {
      const ws = parse(uuidSchema, req.params.id);
      const list = await withUser(uid(req), async (db) => {
        await requireMember(db, ws);
        const q = await db.query(
          `select ${PROJECT_SQL} from projects p where p.workspace_id = $1
           order by (p.status in ('completed', 'archived')), lower(p.name)`,
          [ws],
        );
        return q.rows.map(mapProject);
      });
      res.json(list);
    }),
  );

  r.post(
    "/workspaces/:id/projects",
    handler(async (req, res) => {
      const ws = parse(uuidSchema, req.params.id);
      const input = parse(projectSchema, req.body);
      const id = randomUUID();
      const project = await withUser(uid(req), async (db) => {
        await requireMember(db, ws);
        await db.query(
          `insert into projects (id, workspace_id, name, description, status, color, due_date, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, ws, input.name, input.description || null, input.status, input.color, input.dueDate, uid(req)],
        );
        return mapProject((await db.query(`select ${PROJECT_SQL} from projects p where p.id = $1`, [id])).rows[0]);
      });
      res.status(201).json(project);
    }),
  );

  r.patch(
    "/projects/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const input = parse(projectSchema, req.body);
      const project = await withUser(uid(req), async (db) => {
        const upd = await db.query(
          `update projects set name=$2, description=$3, status=$4, color=$5, due_date=$6 where id = $1`,
          [id, input.name, input.description || null, input.status, input.color, input.dueDate],
        );
        if (upd.rowCount === 0) throw notFound("Project not found");
        return mapProject((await db.query(`select ${PROJECT_SQL} from projects p where p.id = $1`, [id])).rows[0]);
      });
      res.json(project);
    }),
  );

  r.delete(
    "/projects/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      await withUser(uid(req), async (db) => {
        // Tasks keep existing; their project link is cleared first so nothing is lost.
        await db.query(`update tasks set project_id = null where project_id = $1`, [id]);
        const del = await db.query(`delete from projects where id = $1`, [id]);
        if (del.rowCount === 0) throw notFound("Project not found");
      });
      res.json({ ok: true });
    }),
  );

  // ---- Categories ----

  r.post(
    "/workspaces/:id/categories",
    handler(async (req, res) => {
      const ws = parse(uuidSchema, req.params.id);
      const input = parse(categorySchema, req.body);
      const cat = await withUser(uid(req), async (db) => {
        await requireMember(db, ws);
        try {
          const q = await db.query(
            `insert into categories (workspace_id, name, color) values ($1, $2, $3) returning id, name, color`,
            [ws, input.name, input.color],
          );
          return q.rows[0] as Category;
        } catch (e) {
          duplicateName(e);
        }
      });
      res.status(201).json(cat);
    }),
  );

  r.patch(
    "/categories/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const input = parse(categorySchema, req.body);
      const cat = await withUser(uid(req), async (db) => {
        try {
          const q = await db.query(`update categories set name=$2, color=$3 where id=$1 returning id, name, color`, [id, input.name, input.color]);
          if (!q.rows[0]) throw notFound("Category not found");
          return q.rows[0] as Category;
        } catch (e) {
          duplicateName(e);
        }
      });
      res.json(cat);
    }),
  );

  r.delete(
    "/categories/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      await withUser(uid(req), async (db) => {
        await db.query(`update tasks set category_id = null where category_id = $1`, [id]);
        const del = await db.query(`delete from categories where id = $1`, [id]);
        if (del.rowCount === 0) throw notFound("Category not found");
      });
      res.json({ ok: true });
    }),
  );

  return r;
}
