export const DEFAULT_TIMEZONE = "Asia/Dhaka";

export const WORKSPACE_TYPES = ["personal", "organization"] as const;
export type WorkspaceType = (typeof WORKSPACE_TYPES)[number];

export const WORKSPACE_ROLES = ["admin", "manager", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const TASK_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = ["todo", "in_progress", "completed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress"];

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  admin: "Admin",
  manager: "Manager",
  member: "Member",
};

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  admin: "Full access, including members, invitations and settings",
  manager: "Manages projects, assigns tasks and sees team progress",
  member: "Works on tasks assigned to them and comments",
};

/** Reminder presets in minutes before the task time (0 = at task time). Delivery ships in Phase 3. */
export const REMINDER_OFFSETS = [0, 5, 15, 30, 60, 1440] as const;

export const REMINDER_OFFSET_LABELS: Record<(typeof REMINDER_OFFSETS)[number], string> = {
  0: "At task time",
  5: "5 minutes before",
  15: "15 minutes before",
  30: "30 minutes before",
  60: "1 hour before",
  1440: "1 day before",
};

/** Categories created with each new workspace. */
export const DEFAULT_PERSONAL_CATEGORIES = [
  { name: "Family", color: "#16a34a" },
  { name: "Health", color: "#0d9488" },
  { name: "Learning", color: "#7c3aed" },
  { name: "Shopping", color: "#d97706" },
  { name: "Finance", color: "#0369a1" },
  { name: "Routine", color: "#64748b" },
] as const;

export const DEFAULT_ORGANIZATION_CATEGORIES = [
  { name: "General", color: "#2563eb" },
  { name: "Meeting", color: "#7c3aed" },
  { name: "Planning", color: "#0d9488" },
  { name: "Admin", color: "#64748b" },
] as const;

export const LIMITS = {
  passwordMin: 8,
  passwordMax: 128,
  nameMax: 120,
  workspaceNameMax: 80,
  workspaceDescriptionMax: 500,
  taskTitleMax: 300,
  avatarMaxBytes: 2 * 1024 * 1024,
  invitationTtlDays: 7,
} as const;

export const PROJECT_STATUSES = ["active", "on_hold", "completed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  archived: "Archived",
};

export const TASK_SORTS = ["due", "priority", "created", "title"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export const TASK_SORT_LABELS: Record<TaskSort, string> = {
  due: "Due date",
  priority: "Priority",
  created: "Newest first",
  title: "Title A–Z",
};
