import { z } from "zod";
import { RECURRENCE_FREQUENCIES, type Recurrence } from "./recurrence";
import {
  LIMITS,
  PROJECT_STATUSES,
  TASK_SORTS,
  REMINDER_OFFSETS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  WORKSPACE_ROLES,
} from "./constants";

const text = (max: number) => z.string().trim().max(max);

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "Enter a valid email address" }).max(254));

export const passwordSchema = z
  .string()
  .min(LIMITS.passwordMin, { error: `Use at least ${LIMITS.passwordMin} characters` })
  .max(LIMITS.passwordMax, { error: `Use at most ${LIMITS.passwordMax} characters` });

export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { error: "Unknown time zone" });

export const uuidSchema = z.uuid();

/** "YYYY-MM-DD" */
export const dateSchema = z.iso.date({ error: "Use a valid date" });

/** "HH:MM", 24-hour */
export const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Use a valid time" });

const tokenSchema = z.string().min(20).max(200);

// ---------- Auth ----------

export const registerSchema = z.object({
  fullName: text(LIMITS.nameMax).min(1, { error: "Enter your name" }),
  email: emailSchema,
  password: passwordSchema,
  timezone: timezoneSchema.optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { error: "Enter your password" }).max(LIMITS.passwordMax),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({ token: tokenSchema, password: passwordSchema });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const verifyEmailSchema = z.object({ token: tokenSchema });

export const changePasswordSchema = z.object({
  currentPassword: z.string().max(LIMITS.passwordMax).optional(),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ---------- Profile & preferences ----------

export const updateProfileSchema = z.object({
  fullName: text(LIMITS.nameMax).min(1, { error: "Enter your name" }),
  timezone: timezoneSchema,
  weekStartsOn: z.number().int().min(0).max(6),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const notificationPreferencesSchema = z
  .object({
    inAppEnabled: z.boolean(),
    pushEnabled: z.boolean(),
    emailEnabled: z.boolean(),
    defaultReminderOffsets: z
      .array(
        z
          .number()
          .int()
          .refine((n) => (REMINDER_OFFSETS as readonly number[]).includes(n), {
            error: "Unsupported reminder offset",
          }),
      )
      .max(REMINDER_OFFSETS.length),
    missedReminderAlerts: z.boolean(),
    quietHoursEnabled: z.boolean(),
    quietHoursStart: timeSchema.nullable(),
    quietHoursEnd: timeSchema.nullable(),
  })
  .refine((v) => !v.quietHoursEnabled || (v.quietHoursStart && v.quietHoursEnd), {
    error: "Set both a start and an end time",
    path: ["quietHoursEnd"],
  });
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;

// ---------- Workspaces ----------

export const createOrganizationSchema = z.object({
  name: text(LIMITS.workspaceNameMax).min(2, { error: "Use at least 2 characters" }),
  description: text(LIMITS.workspaceDescriptionMax).optional(),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const updateWorkspaceSchema = z.object({
  name: text(LIMITS.workspaceNameMax).min(1, { error: "Enter a name" }),
  description: text(LIMITS.workspaceDescriptionMax).optional(),
});
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

export const deleteWorkspaceSchema = z.object({
  confirmName: z.string().max(LIMITS.workspaceNameMax),
});

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(WORKSPACE_ROLES),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberRoleSchema = z.object({ role: z.enum(WORKSPACE_ROLES) });
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const respondToInvitationSchema = z.union([
  z.object({ token: tokenSchema }),
  z.object({ invitationId: uuidSchema }),
]);
export type RespondToInvitationInput = z.infer<typeof respondToInvitationSchema>;

// ---------- Tasks (Phase 1: quick add and status changes) ----------

export const quickAddTaskSchema = z
  .object({
    workspaceId: uuidSchema,
    title: text(LIMITS.taskTitleMax).min(1, { error: "Give the task a title" }),
    priority: z.enum(TASK_PRIORITIES),
    dueDate: dateSchema.nullable(),
    dueTime: timeSchema.nullable(),
    estimatedMinutes: z.number().int().min(1).max(100000).nullable(),
  })
  .refine((v) => !v.dueTime || v.dueDate, {
    error: "Pick a date for this time",
    path: ["dueTime"],
  });
export type QuickAddTaskInput = z.infer<typeof quickAddTaskSchema>;

export const updateTaskStatusSchema = z.object({ status: z.enum(TASK_STATUSES) });
export type UpdateTaskStatusInput = z.infer<typeof updateTaskStatusSchema>;

// ---------- Tasks (full) ----------


const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: "Use a hex color like #2563eb" });

const tagSchema = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .transform((t) => t.toLowerCase());

export const recurrenceSchema: z.ZodType<Recurrence> = z
  .object({
    frequency: z.enum(RECURRENCE_FREQUENCIES),
    interval: z.number().int().min(1).max(365),
    byWeekday: z.array(z.number().int().min(0).max(6)).max(7),
    byMonthday: z.number().int().min(1).max(31).nullable(),
    endsOn: dateSchema.nullable(),
    maxCount: z.number().int().min(1).max(1000).nullable(),
  })
  .transform((r) => ({ ...r, byWeekday: [...new Set(r.byWeekday)].sort() }));


export const taskFieldsSchema = z.object({
  title: text(LIMITS.taskTitleMax).min(1, { error: "Give the task a title" }),
  description: text(10000).nullable(),
  notes: text(20000).nullable(),
  priority: z.enum(TASK_PRIORITIES),
  status: z.enum(TASK_STATUSES),
  projectId: uuidSchema.nullable(),
  categoryId: uuidSchema.nullable(),
  startDate: dateSchema.nullable(),
  startTime: timeSchema.nullable(),
  dueDate: dateSchema.nullable(),
  dueTime: timeSchema.nullable(),
  estimatedMinutes: z.number().int().min(1).max(100000).nullable(),
  actualMinutes: z.number().int().min(0).max(100000),
  recurrence: recurrenceSchema.nullable(),
  tags: z
    .array(tagSchema)
    .max(20, { error: "Use at most 20 tags" })
    .transform((t) => [...new Set(t)]),
});

/** Cross-field rules shared by create, update and the edit form. */
export function checkTaskDates(
  v: { startDate?: string | null; startTime?: string | null; dueDate?: string | null; dueTime?: string | null; recurrence?: unknown },
  ctx: z.RefinementCtx,
) {
  if (v.dueTime && !v.dueDate) ctx.addIssue({ code: "custom", message: "Pick a due date for this time", path: ["dueTime"] });
  if (v.startTime && !v.startDate) ctx.addIssue({ code: "custom", message: "Pick a start date for this time", path: ["startTime"] });
  if (v.startDate && v.dueDate && v.startDate > v.dueDate) {
    ctx.addIssue({ code: "custom", message: "Start date must be on or before the due date", path: ["dueDate"] });
  }
}

/** A repeating task needs a due date to repeat from. Checked on the final values, never on a partial update. */
export function checkRecurrenceHasDate(v: { dueDate?: string | null; recurrence?: unknown }, ctx: z.RefinementCtx) {
  if (v.recurrence && !v.dueDate) ctx.addIssue({ code: "custom", message: "Repeating tasks need a due date", path: ["dueDate"] });
}

export const createTaskSchema = taskFieldsSchema
  .partial()
  .required({ title: true })
  .extend({ workspaceId: uuidSchema, assigneeIds: z.array(uuidSchema).max(25).optional() })
  .superRefine((v, ctx) => {
    checkTaskDates(v, ctx);
    checkRecurrenceHasDate(v, ctx);
  });
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = taskFieldsSchema.partial().superRefine(checkTaskDates);
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const subtaskTitleSchema = z.object({ title: text(300).min(1, { error: "Enter a title" }) });
export const updateSubtaskSchema = z.object({
  title: text(300).min(1).optional(),
  isDone: z.boolean().optional(),
});

/** Who a task is assigned to: one person, "me", or nobody. */
export const assigneeFilterSchema = z.union([uuidSchema, z.literal("me"), z.literal("none")]);

export const setAssigneesSchema = z.object({ userIds: z.array(uuidSchema).max(25, { error: "Assign a task to at most 25 people" }) });
export type SetAssigneesInput = z.infer<typeof setAssigneesSchema>;

export const commentSchema = z.object({
  body: z.string().trim().min(1, { error: "Write a comment first" }).max(5000, { error: "Keep comments under 5000 characters" }),
});

export const taskListQuerySchema = z.object({
  workspaceId: uuidSchema.optional(),
  assignee: assigneeFilterSchema.optional(),
  status: z.union([z.enum(TASK_STATUSES), z.literal("open")]).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  projectId: uuidSchema.optional(),
  categoryId: uuidSchema.optional(),
  tag: z.string().trim().max(30).optional(),
  q: z.string().trim().max(100).optional(),
  archived: z.enum(["true", "false"]).optional(),
  sort: z.enum(TASK_SORTS).default("due"),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// ---------- Projects & categories ----------

export const projectSchema = z.object({
  name: text(120).min(1, { error: "Enter a name" }),
  description: text(2000).nullable(),
  status: z.enum(PROJECT_STATUSES),
  color: colorSchema,
  dueDate: dateSchema.nullable(),
});
export type ProjectInput = z.infer<typeof projectSchema>;

export const categorySchema = z.object({
  name: text(60).min(1, { error: "Enter a name" }),
  color: colorSchema,
});
export type CategoryInput = z.infer<typeof categorySchema>;

/** Validates the merged dates of an existing task after a partial update. */
export const taskDatesSchema = z
  .object({ startDate: dateSchema.nullable(), startTime: timeSchema.nullable(), dueDate: dateSchema.nullable(), dueTime: timeSchema.nullable(), recurrence: z.unknown().optional() })
  .superRefine((v, ctx) => {
    checkTaskDates(v, ctx);
    checkRecurrenceHasDate(v, ctx);
  });

// ---------- Recurrence, reminders, calendar, push ----------

export const setRemindersSchema = z.object({
  offsets: z
    .array(z.number().int().refine((n) => (REMINDER_OFFSETS as readonly number[]).includes(n), { error: "Unsupported reminder offset" }))
    .max(REMINDER_OFFSETS.length),
  /** Absolute reminder times, ISO 8601. */
  custom: z.array(z.iso.datetime({ offset: true })).max(10),
});
export type SetRemindersInput = z.infer<typeof setRemindersSchema>;

export const snoozeSchema = z.object({
  minutes: z.number().int().min(1).max(10080),
});

export const pushSubscribeSchema = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({ p256dh: z.string().min(10).max(512), auth: z.string().min(10).max(512) }),
});

export const calendarQuerySchema = z.object({
  from: dateSchema,
  to: dateSchema,
  workspaceId: uuidSchema.optional(),
});

// ---------- Phase 5: habits, focus, notes, analytics ----------

export const HABIT_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export const habitSchema = z.object({
  name: text(120).min(1, { error: "Give the habit a name" }),
  description: text(500).nullish(),
  /** Days the habit applies to, 0 = Sunday. */
  byWeekday: z.array(z.number().int().min(0).max(6)).min(1, { error: "Pick at least one day" }).max(7),
  targetPerDay: z.number().int().min(1).max(100).default(1),
});
export type HabitInput = z.infer<typeof habitSchema>;

export const habitLogSchema = z.object({
  date: dateSchema,
  /** 0 removes the entry for that day. */
  count: z.number().int().min(0).max(100),
});

export const FOCUS_KINDS = ["focus", "short_break", "long_break"] as const;
export type FocusKind = (typeof FOCUS_KINDS)[number];

export const startFocusSchema = z.object({
  workspaceId: uuidSchema.nullish(),
  taskId: uuidSchema.nullish(),
  kind: z.enum(FOCUS_KINDS).default("focus"),
  plannedMinutes: z.number().int().min(1).max(240),
});
export type StartFocusInput = z.infer<typeof startFocusSchema>;

export const finishFocusSchema = z.object({
  actualSeconds: z.number().int().min(0).max(240 * 60),
  completed: z.boolean(),
});

export const NOTE_KINDS = ["quick", "task", "meeting", "personal"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  quick: "Quick note",
  task: "Task note",
  meeting: "Meeting note",
  personal: "Personal note",
};

export const noteSchema = z.object({
  title: text(200).nullish(),
  body: z.string().max(50000),
  kind: z.enum(NOTE_KINDS).default("quick"),
  visibility: z.enum(["private", "workspace"]).default("private"),
  taskId: uuidSchema.nullish(),
}).refine((n) => n.body.trim().length > 0 || !!n.title?.trim(), { error: "Write something first", path: ["body"] });
export type NoteInput = z.infer<typeof noteSchema>;

export const analyticsQuerySchema = z.object({
  workspaceId: uuidSchema.optional(),
  days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), { error: "days must be 7, 30 or 90" }).default(7),
});
