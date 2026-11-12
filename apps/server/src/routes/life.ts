import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  addDays,
  analyticsQuerySchema,
  finishFocusSchema,
  habitLogSchema,
  habitSchema,
  localDate,
  noteSchema,
  startFocusSchema,
  uuidSchema,
  weekdayOf,
  zonedToUtc,
  type Analytics,
  type FocusSession,
  type FocusSummary,
  type Habit,
  type Note,
} from "@lifesync/shared";
import { requireAuth, uid } from "../auth/sessions";
import type { AppContext } from "../context";
import { withUser, type Db } from "../db/pool";
import { badRequest, handler, notFound, parse } from "../http";
import { logActivity } from "../services/collab";
import { computeStreaks, dueOn, isDone } from "../services/habits";

async function timezoneOf(db: Db, userId: string): Promise<string> {
  return (await db.query(`select timezone from profiles where id = $1`, [userId])).rows[0].timezone as string;
}

async function requireMember(db: Db, workspaceId: string) {
  const q = await db.query(`select 1 from workspace_members where workspace_id = $1 and user_id = app.current_user_id()`, [workspaceId]);
  if (!q.rows[0]) throw notFound("Workspace not found");
}

// ---------- mapping ----------

const FOCUS_SQL = `f.id, f.workspace_id, f.task_id, t.title as task_title, f.kind, f.planned_minutes, f.actual_seconds,
  f.started_at, f.ended_at, f.completed`;
const FOCUS_FROM = `focus_sessions f left join tasks t on t.id = f.task_id`;

function mapFocus(r: Record<string, any>): FocusSession {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    taskId: r.task_id,
    taskTitle: r.task_title,
    kind: r.kind,
    plannedMinutes: r.planned_minutes,
    actualSeconds: r.actual_seconds,
    startedAt: new Date(r.started_at).toISOString(),
    endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    completed: r.completed,
  };
}

const NOTE_SQL = `n.id, n.workspace_id, n.author_id, p.full_name as author_name, n.task_id, t.title as task_title,
  n.kind, n.visibility, n.title, n.body, n.created_at, n.updated_at`;
const NOTE_FROM = `notes n join profiles p on p.id = n.author_id left join tasks t on t.id = n.task_id`;

function mapNote(r: Record<string, any>, me: string): Note {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    authorId: r.author_id,
    authorName: r.author_name,
    mine: r.author_id === me,
    taskId: r.task_id,
    taskTitle: r.task_title,
    kind: r.kind,
    visibility: r.visibility,
    title: r.title,
    body: r.body,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export function lifeRouter(_ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth);

  // ================= Habits =================

  async function loadHabits(db: Db, userId: string, workspaceId: string, onlyId?: string): Promise<Habit[]> {
    const tz = await timezoneOf(db, userId);
    const today = localDate(new Date(), tz);
    const since = addDays(today, -800);
    const habits = (
      await db.query(
        `select id, workspace_id, name, description, by_weekday, target_per_day, created_at
         from habits where workspace_id = $1 and user_id = $2 and archived_at is null and ($3::uuid is null or id = $3)
         order by created_at`,
        [workspaceId, userId, onlyId ?? null],
      )
    ).rows;
    if (!habits.length) return [];
    const logRows = (
      await db.query(
        `select habit_id, log_date::text as d, count from habit_logs where habit_id = any($1::uuid[]) and log_date >= $2::date`,
        [habits.map((h) => h.id), since],
      )
    ).rows;
    const byHabit = new Map<string, Map<string, number>>();
    for (const l of logRows) {
      if (!byHabit.has(l.habit_id)) byHabit.set(l.habit_id, new Map());
      byHabit.get(l.habit_id)!.set(l.d, l.count);
    }
    return habits.map((h) => {
      const logs = byHabit.get(h.id) ?? new Map<string, number>();
      const created = localDate(new Date(h.created_at), tz);
      const firstLog = [...logs.keys()].sort()[0];
      const shape = {
        byWeekday: h.by_weekday as number[],
        targetPerDay: h.target_per_day as number,
        startDate: firstLog && firstLog < created ? firstLog : created,
      };
      const streaks = computeStreaks(shape, logs, today);
      const history = Array.from({ length: 14 }, (_, i) => {
        const date = addDays(today, i - 13);
        const count = logs.get(date) ?? 0;
        return { date, count, due: dueOn(shape, date), done: isDone(shape, count) };
      });
      return {
        id: h.id,
        workspaceId: h.workspace_id,
        name: h.name,
        description: h.description,
        byWeekday: shape.byWeekday,
        targetPerDay: shape.targetPerDay,
        todayCount: logs.get(today) ?? 0,
        dueToday: dueOn(shape, today),
        currentStreak: streaks.current,
        longestStreak: streaks.longest,
        history,
        totalDone: [...logs.values()].filter((c) => c >= shape.targetPerDay).length,
      };
    });
  }

  r.get(
    "/workspaces/:id/habits",
    handler(async (req, res) => {
      const ws = parse(uuidSchema, req.params.id);
      const me = uid(req);
      res.json(
        await withUser(me, async (db) => {
          await requireMember(db, ws);
          return loadHabits(db, me, ws);
        }),
      );
    }),
  );

  r.post(
    "/workspaces/:id/habits",
    handler(async (req, res) => {
      const ws = parse(uuidSchema, req.params.id);
      const input = parse(habitSchema, req.body);
      const me = uid(req);
      const id = randomUUID();
      const habit = await withUser(me, async (db) => {
        await requireMember(db, ws);
        await db.query(
          `insert into habits (id, workspace_id, user_id, name, description, by_weekday, target_per_day) values ($1,$2,$3,$4,$5,$6,$7)`,
          [id, ws, me, input.name, input.description || null, [...new Set(input.byWeekday)].sort(), input.targetPerDay],
        );
        return (await loadHabits(db, me, ws, id))[0];
      });
      res.status(201).json(habit);
    }),
  );

  r.patch(
    "/habits/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const input = parse(habitSchema, req.body);
      const me = uid(req);
      const habit = await withUser(me, async (db) => {
        const upd = await db.query(
          `update habits set name=$2, description=$3, by_weekday=$4, target_per_day=$5
           where id = $1 and user_id = $6 and archived_at is null returning workspace_id`,
          [id, input.name, input.description || null, [...new Set(input.byWeekday)].sort(), input.targetPerDay, me],
        );
        if (!upd.rows[0]) throw notFound("Habit not found");
        return (await loadHabits(db, me, upd.rows[0].workspace_id, id))[0];
      });
      res.json(habit);
    }),
  );

  r.delete(
    "/habits/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      await withUser(uid(req), async (db) => {
        const del = await db.query(`delete from habits where id = $1 and user_id = $2`, [id, uid(req)]);
        if (del.rowCount === 0) throw notFound("Habit not found");
      });
      res.json({ ok: true });
    }),
  );

  r.put(
    "/habits/:id/log",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const { date, count } = parse(habitLogSchema, req.body);
      const me = uid(req);
      const habit = await withUser(me, async (db) => {
        const h = await db.query(`select workspace_id, by_weekday, target_per_day from habits where id = $1 and user_id = $2 and archived_at is null`, [id, me]);
        if (!h.rows[0]) throw notFound("Habit not found");
        if (count > h.rows[0].target_per_day) {
          throw badRequest(`Count can't exceed the daily target (${h.rows[0].target_per_day})`, "over_target");
        }
        if (count > 0 && !(h.rows[0].by_weekday as number[]).includes(weekdayOf(date))) {
          throw badRequest("This habit isn't scheduled for that day", "off_day");
        }
        const today = localDate(new Date(), await timezoneOf(db, me));
        if (date > today) throw badRequest("You can't log a habit for a future day", "future_date");
        if (date < addDays(today, -60)) throw badRequest("That day is too far back to change", "too_old");
        if (count === 0) {
          await db.query(`delete from habit_logs where habit_id = $1 and log_date = $2`, [id, date]);
        } else {
          await db.query(
            `insert into habit_logs (habit_id, workspace_id, user_id, log_date, count) values ($1,$2,$3,$4,$5)
             on conflict (habit_id, log_date) do update set count = excluded.count`,
            [id, h.rows[0].workspace_id, me, date, count],
          );
        }
        return (await loadHabits(db, me, h.rows[0].workspace_id, id))[0];
      });
      res.json(habit);
    }),
  );

  // ================= Focus =================

  r.get(
    "/focus",
    handler(async (req, res) => {
      const me = uid(req);
      const summary = await withUser(me, async (db): Promise<FocusSummary> => {
        const tz = await timezoneOf(db, me);
        const today = localDate(new Date(), tz);
        const todayStart = zonedToUtc(today, "00:00", tz);
        const weekStart = zonedToUtc(addDays(today, -6), "00:00", tz);
        const active = await db.query(
          `select ${FOCUS_SQL} from ${FOCUS_FROM} where f.user_id = $1 and f.ended_at is null order by f.started_at desc limit 1`,
          [me],
        );
        const agg = await db.query(
          `select
             coalesce(sum(actual_seconds) filter (where started_at >= $2), 0)::int as today_s,
             count(*) filter (where started_at >= $2 and completed)::int as today_n,
             coalesce(sum(actual_seconds), 0)::int as week_s
           from focus_sessions where user_id = $1 and kind = 'focus' and ended_at is not null and started_at >= $3`,
          [me, todayStart, weekStart],
        );
        const recent = await db.query(
          `select ${FOCUS_SQL} from ${FOCUS_FROM} where f.user_id = $1 and f.ended_at is not null and f.kind = 'focus'
           order by f.started_at desc limit 8`,
          [me],
        );
        return {
          today,
          active: active.rows[0] ? mapFocus(active.rows[0]) : null,
          todayFocusMinutes: Math.round(agg.rows[0].today_s / 60),
          todaySessions: agg.rows[0].today_n,
          weekFocusMinutes: Math.round(agg.rows[0].week_s / 60),
          recent: recent.rows.map(mapFocus),
        };
      });
      res.json(summary);
    }),
  );

  r.post(
    "/focus",
    handler(async (req, res) => {
      const input = parse(startFocusSchema, req.body);
      const me = uid(req);
      const id = randomUUID();
      const session = await withUser(me, async (db) => {
        let workspaceId = input.workspaceId ?? null;
        if (input.taskId) {
          const t = await db.query(`select workspace_id from tasks where id = $1`, [input.taskId]);
          if (!t.rows[0]) throw notFound("Task not found");
          workspaceId = t.rows[0].workspace_id;
        }
        if (workspaceId) await requireMember(db, workspaceId);
        // A forgotten timer must not block a new one: close anything still open, keeping what it measured.
        await db.query(
          `update focus_sessions set ended_at = now(), completed = false,
             actual_seconds = least(planned_minutes * 60, greatest(0, extract(epoch from now() - started_at)::int))
           where user_id = $1 and ended_at is null`,
          [me],
        );
        await db.query(
          `insert into focus_sessions (id, workspace_id, user_id, task_id, kind, planned_minutes) values ($1,$2,$3,$4,$5,$6)`,
          [id, workspaceId, me, input.taskId ?? null, input.kind, input.plannedMinutes],
        );
        return mapFocus((await db.query(`select ${FOCUS_SQL} from ${FOCUS_FROM} where f.id = $1`, [id])).rows[0]);
      });
      res.status(201).json(session);
    }),
  );

  r.post(
    "/focus/:id/finish",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const input = parse(finishFocusSchema, req.body);
      const me = uid(req);
      const session = await withUser(me, async (db) => {
        const cur = await db.query(
          `select planned_minutes, started_at, kind, task_id from focus_sessions where id = $1 and user_id = $2 and ended_at is null for update`,
          [id, me],
        );
        if (!cur.rows[0]) throw notFound("Focus session not found or already finished");
        // Never trust the client clock beyond what the server saw: cap at elapsed wall time.
        const elapsed = Math.max(0, Math.floor((Date.now() - new Date(cur.rows[0].started_at).getTime()) / 1000));
        const seconds = Math.min(input.actualSeconds, elapsed + 5, cur.rows[0].planned_minutes * 60);
        await db.query(`update focus_sessions set ended_at = now(), actual_seconds = $2, completed = $3 where id = $1`, [id, seconds, input.completed]);
        const minutes = Math.round(seconds / 60);
        if (cur.rows[0].kind === "focus" && cur.rows[0].task_id && minutes > 0) {
          // Time spent lands on the task when the caller is allowed to update it; RLS decides.
          await db.query(`update tasks set actual_minutes = actual_minutes + $2 where id = $1`, [cur.rows[0].task_id, minutes]);
        }
        return mapFocus((await db.query(`select ${FOCUS_SQL} from ${FOCUS_FROM} where f.id = $1`, [id])).rows[0]);
      });
      res.json(session);
    }),
  );

  // ================= Notes =================

  r.get(
    "/workspaces/:id/notes",
    handler(async (req, res) => {
      const ws = parse(uuidSchema, req.params.id);
      const { q, kind } = parse(z.object({ q: z.string().trim().max(100).optional(), kind: z.enum(["quick", "task", "meeting", "personal"]).optional() }), req.query);
      const me = uid(req);
      const notes = await withUser(me, async (db) => {
        await requireMember(db, ws);
        const rows = await db.query(
          `select ${NOTE_SQL} from ${NOTE_FROM}
           where n.workspace_id = $1 and ($2::note_kind is null or n.kind = $2)
             and ($3::text is null or n.title ilike '%' || $3 || '%' or n.body ilike '%' || $3 || '%')
           order by n.updated_at desc limit 200`,
          [ws, kind ?? null, q ? q.replace(/[%_\\]/g, "\\$&") : null],
        );
        return rows.rows.map((n) => mapNote(n, me));
      });
      res.json(notes);
    }),
  );

  r.post(
    "/workspaces/:id/notes",
    handler(async (req, res) => {
      const ws = parse(uuidSchema, req.params.id);
      const input = parse(noteSchema, req.body);
      const me = uid(req);
      const id = randomUUID();
      const note = await withUser(me, async (db) => {
        await requireMember(db, ws);
        const kind = input.taskId ? "task" : input.kind;
        try {
          await db.query(
            `insert into notes (id, workspace_id, author_id, task_id, kind, visibility, title, body) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [id, ws, me, input.taskId ?? null, kind, input.visibility, input.title?.trim() || null, input.body],
          );
        } catch (e) {
          if ((e as { code?: string }).code === "23503") throw badRequest("That task is not in this workspace", "bad_task");
          throw e;
        }
        return mapNote((await db.query(`select ${NOTE_SQL} from ${NOTE_FROM} where n.id = $1`, [id])).rows[0], me);
      });
      res.status(201).json(note);
    }),
  );

  r.patch(
    "/notes/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const input = parse(noteSchema, req.body);
      const me = uid(req);
      const note = await withUser(me, async (db) => {
        const upd = await db.query(`update notes set title=$2, body=$3, kind=$4, visibility=$5 where id = $1`, [
          id,
          input.title?.trim() || null,
          input.body,
          input.kind,
          input.visibility,
        ]);
        if (upd.rowCount === 0) throw notFound("Note not found");
        return mapNote((await db.query(`select ${NOTE_SQL} from ${NOTE_FROM} where n.id = $1`, [id])).rows[0], me);
      });
      res.json(note);
    }),
  );

  r.delete(
    "/notes/:id",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      await withUser(uid(req), async (db) => {
        const del = await db.query(`delete from notes where id = $1`, [id]);
        if (del.rowCount === 0) throw notFound("Note not found");
      });
      res.json({ ok: true });
    }),
  );

  /** Turns a note into a task assigned to the caller. The note stays, linked to the new task. */
  r.post(
    "/notes/:id/convert",
    handler(async (req, res) => {
      const id = parse(uuidSchema, req.params.id);
      const me = uid(req);
      const taskId = randomUUID();
      const out = await withUser(me, async (db) => {
        const n = (await db.query(`select workspace_id, title, body, author_id from notes where id = $1`, [id])).rows[0];
        if (!n || n.author_id !== me) throw notFound("Note not found");
        const firstLine = String(n.body).split("\n").find((l: string) => l.trim()) ?? "";
        const title = (n.title?.trim() || firstLine.trim() || "Untitled task").slice(0, 300);
        await db.query(`insert into tasks (id, workspace_id, title, notes, created_by) values ($1,$2,$3,$4,$5)`, [
          taskId,
          n.workspace_id,
          title,
          n.body.trim() ? n.body : null,
          me,
        ]);
        await db.query(`insert into task_assignees (task_id, workspace_id, user_id, assigned_by) values ($1,$2,$3,$3)`, [taskId, n.workspace_id, me]);
        await db.query(`update notes set task_id = $2, kind = 'task' where id = $1`, [id, taskId]);
        await logActivity(db, n.workspace_id, me, "task", taskId, "task.created", { title });
        return { taskId, workspaceId: n.workspace_id as string };
      });
      res.status(201).json(out);
    }),
  );

  // ================= Analytics =================

  r.get(
    "/analytics",
    handler(async (req, res) => {
      const { workspaceId, days } = parse(analyticsQuerySchema, req.query);
      const me = uid(req);
      const data = await withUser(me, async (db): Promise<Analytics> => {
        const tz = await timezoneOf(db, me);
        const today = localDate(new Date(), tz);
        const from = addDays(today, -(days - 1));
        const fromUtc = zonedToUtc(from, "00:00", tz);
        if (workspaceId) await requireMember(db, workspaceId);
        // "Mine": every task in my personal workspaces plus organization tasks assigned to me.
        const mine = `
          t.archived_at is null and ($1::uuid is null or t.workspace_id = $1) and (
            w.type = 'personal'
            or exists (select 1 from task_assignees a where a.task_id = t.id and a.user_id = app.current_user_id()))`;
        const taskFrom = `tasks t join workspaces w on w.id = t.workspace_id`;
        const ws = workspaceId ?? null;

        const doneQ = await db.query(
          `select (t.completed_at at time zone $3)::date::text as d, w.type::text as type, count(*)::int as n
           from ${taskFrom} where ${mine} and t.status = 'completed' and t.completed_at >= $2
           group by 1, 2`,
          [ws, fromUtc, tz],
        );
        const createdQ = await db.query(
          `select (t.created_at at time zone $3)::date::text as d, count(*)::int as n
           from ${taskFrom} where ${mine} and t.created_at >= $2 and t.status <> 'cancelled' group by 1`,
          [ws, fromUtc, tz],
        );
        const focusQ = await db.query(
          `select (f.started_at at time zone $4)::date::text as d, coalesce(w.type::text, 'personal') as type,
             sum(f.actual_seconds)::int as s, count(*) filter (where f.completed)::int as n
           from focus_sessions f left join workspaces w on w.id = f.workspace_id
           where f.user_id = $1 and f.kind = 'focus' and f.ended_at is not null and f.started_at >= $3
             and ($2::uuid is null or f.workspace_id = $2)
           group by 1, 2`,
          [me, ws, fromUtc, tz],
        );
        const openQ = await db.query(
          `select count(*)::int as open, count(*) filter (where t.due_date < $2::date)::int as overdue
           from ${taskFrom} where ${mine} and t.status in ('todo','in_progress')`,
          [ws, today],
        );
        const habitQ = await db.query(
          `select h.by_weekday, h.target_per_day, h.created_at,
             (select jsonb_object_agg(l.log_date::text, l.count) from habit_logs l where l.habit_id = h.id and l.log_date >= $3::date) as logs
           from habits h where h.user_id = $1 and h.archived_at is null and ($2::uuid is null or h.workspace_id = $2)`,
          [me, ws, from],
        );

        const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
        const daily = new Map(dates.map((d) => [d, { date: d, completed: 0, created: 0, focusMinutes: 0 }]));
        const distribution = { work: { completed: 0, focusMinutes: 0 }, personal: { completed: 0, focusMinutes: 0 } };
        const weekdayDone = Array.from({ length: 7 }, () => 0);
        let completed = 0;
        for (const row of doneQ.rows) {
          const day = daily.get(row.d);
          if (day) day.completed += row.n;
          completed += row.n;
          weekdayDone[weekdayOf(row.d)]! += row.n;
          distribution[row.type === "organization" ? "work" : "personal"].completed += row.n;
        }
        for (const row of createdQ.rows) {
          const day = daily.get(row.d);
          if (day) day.created += row.n;
        }
        let focusSeconds = 0;
        let focusSessions = 0;
        for (const row of focusQ.rows) {
          const day = daily.get(row.d);
          if (day) day.focusMinutes += Math.round(row.s / 60);
          focusSeconds += row.s;
          focusSessions += row.n;
          distribution[row.type === "organization" ? "work" : "personal"].focusMinutes += Math.round(row.s / 60);
        }

        let scheduledDays = 0;
        let doneDays = 0;
        for (const h of habitQ.rows) {
          const logs = (h.logs ?? {}) as Record<string, number>;
          const created = localDate(new Date(h.created_at), tz);
          for (const d of dates) {
            if (d < created || !(h.by_weekday as number[]).includes(weekdayOf(d))) continue;
            if (d === today && (logs[d] ?? 0) < h.target_per_day) continue; // today isn't over yet
            scheduledDays++;
            if ((logs[d] ?? 0) >= h.target_per_day) doneDays++;
          }
        }

        const open = openQ.rows[0].open as number;
        const overdue = openQ.rows[0].overdue as number;
        return {
          from,
          to: today,
          days,
          scope: workspaceId ? "workspace" : "all",
          totals: {
            completed,
            pending: open,
            overdue,
            overduePercent: open ? Math.round((overdue / open) * 100) : 0,
            focusMinutes: Math.round(focusSeconds / 60),
            focusSessions,
          },
          daily: [...daily.values()],
          distribution,
          weekdays: weekdayDone.map((c, weekday) => ({ weekday, completed: c })),
          habits: { scheduledDays, doneDays },
        };
      });
      res.json(data);
    }),
  );

  return r;
}
