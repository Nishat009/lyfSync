import type { TaskPriority, TaskStatus, WorkspaceRole, WorkspaceType } from "./constants";

/** Error body returned by every failing API call. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Field name -> message, for validation errors. */
    fields?: Record<string, string>;
  };
}

export interface WorkspaceSummary {
  id: string;
  type: WorkspaceType;
  name: string;
  description: string | null;
  role: WorkspaceRole;
  memberCount: number;
}

export interface Profile {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  timezone: string;
  weekStartsOn: number;
}

export interface NotificationPreferences {
  inAppEnabled: boolean;
  pushEnabled: boolean;
  emailEnabled: boolean;
  defaultReminderOffsets: number[];
  missedReminderAlerts: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

export interface Me {
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
    hasPassword: boolean;
    hasGoogle: boolean;
  };
  profile: Profile;
  workspaces: WorkspaceSummary[];
  unreadNotifications: number;
  pendingInvitations: number;
}

export interface Category {
  id: string;
  name: string;
  color: string;
}

export interface WorkspaceDetail extends WorkspaceSummary {
  createdAt: string;
  categories: Category[];
}

export interface Member {
  userId: string;
  fullName: string;
  email: string;
  avatarUrl: string | null;
  role: WorkspaceRole;
  joinedAt: string;
}

export type InvitationStatus = "pending" | "accepted" | "revoked" | "declined" | "expired";

export interface Invitation {
  id: string;
  email: string;
  role: WorkspaceRole;
  status: InvitationStatus;
  invitedByName: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface CreatedInvitation {
  invitation: Invitation;
  /** The raw link. Returned once, when the invitation is created or resent. */
  inviteUrl: string;
  emailSent: boolean;
}

export interface InvitationPreview {
  workspaceName: string;
  invitedByName: string | null;
  email: string;
  role: WorkspaceRole;
  status: InvitationStatus;
  expiresAt: string;
}

export interface MyInvitation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  invitedByName: string | null;
  role: WorkspaceRole;
  expiresAt: string;
}

export interface TaskSummary {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceType: WorkspaceType;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string | null;
  dueTime: string | null;
  dueAt: string | null;
  completedAt: string | null;
  estimatedMinutes: number | null;
  categoryName: string | null;
  categoryColor: string | null;
}

export type DashboardScope =
  | { type: "all" }
  | { type: "workspace"; workspaceId: string; workspaceType: WorkspaceType; workspaceName: string };

export interface DashboardData {
  /** Local date in the user's time zone, YYYY-MM-DD. */
  today: string;
  timezone: string;
  scope: DashboardScope;
  summary: {
    total: number;
    completed: number;
    pending: number;
    overdue: number;
    /** 0-100, share of today's tasks that are completed. */
    progress: number;
  };
  /** Today's tasks without a time. */
  todayTasks: TaskSummary[];
  /** Today's tasks with a time, in time order. */
  schedule: TaskSummary[];
  overdueTasks: TaskSummary[];
  upcomingTasks: TaskSummary[];
  balance: {
    open: { work: number; personal: number };
    completedLast7Days: { work: number; personal: number };
  };
  openByPriority: Record<TaskPriority, number>;
  weekly: { date: string; completed: number; due: number }[];
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  taskId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationItem[];
  nextCursor: string | null;
}

export interface Assignee {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
}

export interface TaskListItem extends TaskSummary {
  assignees: Assignee[];
  projectId: string | null;
  projectName: string | null;
  tags: string[];
  subtasksDone: number;
  subtasksTotal: number;
  archived: boolean;
  recurring: boolean;
}

export interface Subtask {
  id: string;
  title: string;
  isDone: boolean;
}

export interface TaskDetail extends TaskListItem {
  description: string | null;
  notes: string | null;
  categoryId: string | null;
  startDate: string | null;
  startTime: string | null;
  actualMinutes: number;
  createdAt: string;
  createdByName: string | null;
  createdById: string | null;
  /** What the signed-in person may do with this task (decided by the server). */
  permissions: TaskPermissions;
  subtasks: Subtask[];
  recurrence: import("./recurrence").Recurrence | null;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: import("./constants").ProjectStatus;
  color: string;
  dueDate: string | null;
  taskTotal: number;
  taskDone: number;
}

export interface TaskReminder {
  id: string;
  offsetMinutes: number | null;
  remindAt: string;
  status: "pending" | "processing" | "sent" | "failed" | "cancelled";
}

export interface UpcomingReminder {
  id: string;
  taskId: string;
  taskTitle: string;
  workspaceId: string;
  workspaceName: string;
  workspaceType: WorkspaceType;
  remindAt: string;
  offsetMinutes: number | null;
}

export interface CalendarItem extends TaskListItem {
  startDate: string | null;
  startTime: string | null;
}

export interface CalendarData {
  from: string;
  to: string;
  timezone: string;
  items: CalendarItem[];
  reminders: UpcomingReminder[];
}

export interface PushStatus {
  /** Whether the server can send web push at all (VAPID keys configured). */
  configured: boolean;
  publicKey: string | null;
  subscriptions: number;
}

export interface TaskPermissions {
  /** Change any field, archive or duplicate. Creators, managers and admins. */
  edit: boolean;
  /** Choose who the task is assigned to. Managers and admins. */
  assign: boolean;
  delete: boolean;
}

export interface TaskComment {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  author: { userId: string; fullName: string; avatarUrl: string | null } | null;
  canEdit: boolean;
  canDelete: boolean;
}

export interface ActivityEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  /** Title of the task the entry is about, when it is a task event. */
  taskTitle: string | null;
  actor: { userId: string; fullName: string } | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TeamMemberLoad {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
  role: WorkspaceRole;
  open: number;
  inProgress: number;
  dueToday: number;
  overdue: number;
  completedLast7Days: number;
}

export interface TeamOverview {
  today: string;
  members: TeamMemberLoad[];
  unassignedOpen: number;
  totals: { open: number; overdue: number; completedLast7Days: number };
}

// ---------- Phase 5 ----------

export interface Habit {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  byWeekday: number[];
  targetPerDay: number;
  /** Count logged today. */
  todayCount: number;
  /** Is today a scheduled day for this habit. */
  dueToday: boolean;
  currentStreak: number;
  longestStreak: number;
  /** Last 14 days, oldest first. `due` is false on days the habit is not scheduled. */
  history: { date: string; count: number; due: boolean; done: boolean }[];
  totalDone: number;
}

export interface FocusSession {
  id: string;
  workspaceId: string | null;
  taskId: string | null;
  taskTitle: string | null;
  kind: "focus" | "short_break" | "long_break";
  plannedMinutes: number;
  actualSeconds: number;
  startedAt: string;
  endedAt: string | null;
  completed: boolean;
}

export interface FocusSummary {
  today: string;
  active: FocusSession | null;
  todayFocusMinutes: number;
  todaySessions: number;
  weekFocusMinutes: number;
  recent: FocusSession[];
}

export interface Note {
  id: string;
  workspaceId: string;
  authorId: string;
  authorName: string;
  mine: boolean;
  taskId: string | null;
  taskTitle: string | null;
  kind: "quick" | "task" | "meeting" | "personal";
  visibility: "private" | "workspace";
  title: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Analytics {
  from: string;
  to: string;
  days: number;
  scope: "all" | "workspace";
  totals: {
    completed: number;
    pending: number;
    overdue: number;
    /** Overdue open tasks as a share of all open tasks, 0..100. */
    overduePercent: number;
    focusMinutes: number;
    focusSessions: number;
  };
  /** One entry per day in the range, oldest first. */
  daily: { date: string; completed: number; created: number; focusMinutes: number }[];
  /** Completed tasks and focus minutes split by workspace kind. */
  distribution: { work: { completed: number; focusMinutes: number }; personal: { completed: number; focusMinutes: number } };
  /** Completed tasks by weekday (0 = Sunday) over the range. */
  weekdays: { weekday: number; completed: number }[];
  /** Habit completion across the range: scheduled days vs days fully done. */
  habits: { scheduledDays: number; doneDays: number };
}
