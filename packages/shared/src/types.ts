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

export interface TaskListItem extends TaskSummary {
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
  assignees: { userId: string; fullName: string }[];
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
