# Project: LifeSync – Personal & Professional Life Management System

Act as a Senior Full-Stack Engineer, SaaS Product Architect, and UI/UX Designer.

I want to build a modern, responsive, production-ready productivity and task management application called **LifeSync**.

## 1. Project Vision

LifeSync is a unified productivity platform that helps individuals manage their professional responsibilities and personal lives from one place.

The application must support two major environments:

1. Personal Workspace – Private tasks, family responsibilities, personal goals, learning, shopping, health routines, and everyday activities.
2. Organization Workspace – Professional projects, team tasks, assignments, meetings, deadlines, and collaboration.

The application should initially work perfectly for a single user but must also support multiple organizations and teams.

The primary goal is to help users maintain a healthy work-life balance without forgetting important responsibilities.

## 2. Recommended Technology Stack

Use the following stack:

Frontend:
- Next.js (App Router)
- TypeScript
- Tailwind CSS
- shadcn/ui
- Lucide Icons
- React Hook Form
- Zod for validation

Backend:
- Next.js Server Actions / API Routes
-Node.js

Express.js

TypeScript

Prisma ORM

PostgreSQL

Redis

BullMQ

Socket.IO

Zod for request validation

JWT authentication



Use clean architecture and reusable components.

## 3. Authentication & User Management

Implement:
- Email and password registration
- Login and logout
- Forgot password
- Password reset
- Google OAuth (if configured)
- User profile management
- Profile image upload
- User timezone and notification preferences

Each user should have a personal workspace automatically created after registration.

## 4. Workspace Management

Implement a workspace switcher in the sidebar.

Workspace types:

A. Personal Workspace
- Only accessible to its owner.
- Private tasks and notes.
- Personal reminders.
- Personal goals.
- Family-related activities.
- Learning and career development.
- Daily routines.

B. Organization Workspace
- Users can create organizations.
- Users can join organizations through invitations.
- Support multiple organizations per user.
- Organization members can collaborate.
- Admin, Manager, and Member roles.

Important:
Personal workspace data must NEVER be accessible to organization members or administrators.

Implement proper database-level access control using Supabase RLS.

## 5. Main Dashboard

Create a beautiful dashboard containing:

- Personalized greeting.
- Current date and day.
- Today's completed tasks.
- Today's pending tasks.
- Overall progress percentage.
- Work vs Personal task distribution.
- Upcoming reminders.
- Overdue tasks.
- Today's schedule.
- Quick Add Task button.
- Weekly productivity chart.

Include a workspace-specific dashboard and an optional combined My Day dashboard.

The combined dashboard should display personal and professional tasks together while preserving their separate privacy boundaries.

## 6. Task Management

Each task should support:

- Task title
- Description
- Workspace
- Project
- Category
- Priority (Urgent, High, Medium, Low)
- Status (To Do, In Progress, Completed, Cancelled)
- Start date
- Due date
- Start time
- Due time
- Estimated duration
- Actual duration
- Assigned user
- Tags
- Attachments
- Subtasks / Checklists
- Notes
- Multiple reminders
- Recurring configuration

Task operations:
- Create
- Edit
- Delete
- Duplicate
- Archive
- Complete
- Reopen
- Reschedule
- Search
- Filter
- Sort

Support both list view and Kanban board view.

## 7. Smart Reminder & Notification System

This is one of the most important features.

Allow users to configure reminders when creating or editing tasks.

Reminder options:
- At task time
- 5 minutes before
- 15 minutes before
- 30 minutes before
- 1 hour before
- 1 day before
- Custom date and time

Notification channels:
- In-app notifications
- Browser push notifications
- Email notifications

Additional functionality:
- Snooze reminder
- Mark task as completed from notification where supported
- Upcoming reminder list
- Missed reminder alerts
- Notification history
- Notification preferences
- Enable/disable individual channels

Technical requirements:
- Implement a backend reminder scheduler.
- Store reminder delivery status in the database.
- Prevent duplicate notifications.
- Support recurring reminders.
- Respect user timezone.
- Use Asia/Dhaka as the default timezone for Bangladesh users.
- Do not depend exclusively on browser timers.
- Ensure scheduled reminders can be delivered when the application tab is closed, provided the browser/device supports push notifications and permission has been granted.
- Add retry and failure handling for notification delivery.

## 8. Calendar & Daily Planner

Implement:
- Daily calendar
- Weekly calendar
- Monthly calendar
- Agenda view

Users should be able to:
- View all tasks by date.
- Drag and drop tasks to reschedule.
- Create tasks directly from calendar.
- View upcoming meetings.
- Identify scheduling conflicts.
- See reminders and deadlines.

Create a dedicated My Day page that combines tasks from Personal and Organization workspaces.

## 9. Recurring Tasks & Habits

Support recurring tasks:

- Every day
- Every weekday
- Every week
- Selected weekdays
- Every month
- Every year
- Custom recurrence

Examples:
- Daily office task review.
- Weekly grocery shopping.
- Monthly bill payment.
- Daily learning session.
- Weekly project review.

Also create a simple habit tracker with streaks and completion history.

## 10. Organization & Team Collaboration

Organization features:

- Create organization
- Invite members via email
- Member management
- Role-based permissions
- Create projects
- Assign tasks to team members
- Task comments
- Activity timeline
- Team task overview
- Project progress tracking

Roles:

Admin:
- Full organization management access.

Manager:
- Manage projects and assign tasks.
- View team progress.

Member:
- View assigned tasks.
- Update task status.
- Collaborate through comments.

Never allow organization roles to override personal workspace privacy.

## 11. Focus Mode

Create a distraction-free Focus Mode.

Features:
- Start a focus session.
- Select a task.
- 25-minute Pomodoro timer.
- 5-minute short break.
- 15-minute long break.
- Custom timer settings.
- Track completed focus sessions.
- Record time spent on tasks.

## 12. Work-Life Balance Analytics

Build an analytics page with:

- Daily productivity.
- Weekly productivity.
- Monthly productivity.
- Completed vs pending tasks.
- Overdue task percentage.
- Work vs Personal time distribution.
- Focus hours.
- Most productive days.
- Task completion trends.

Use clean and understandable charts.

Avoid presenting productivity as a competition. The purpose is to help users understand and improve their daily balance.

## 13. Notes & Quick Capture

Implement:
- Quick notes.
- Task-related notes.
- Meeting notes.
- Personal notes.
- Convert note into task.
- Quick Add from anywhere in the application.

## 14. UI/UX Design Requirements

Design a premium, modern productivity SaaS interface.

Visual direction:
- Clean and minimal.
- Soft neutral background.
- White cards.
- Subtle borders and shadows.
- Rounded corners.
- Comfortable spacing.
- Professional typography.
- Blue accent for Work.
- Green accent for Personal.
- Avoid excessive gradients and bright colors.

Layout:
- Collapsible left sidebar.
- Top navigation bar.
- Workspace switcher.
- Search.
- Notification center.
- User profile dropdown.

The UI must be:
- Fully responsive.
- Mobile-friendly.
- Accessible.
- Consistent across all pages.
- Easy to use without unnecessary complexity.

Include:
- Skeleton loading states.
- Empty states.
- Error states.
- Confirmation dialogs.
- Toast notifications.
- Form validation.

## 15. Database Design

Design a normalized PostgreSQL database.

Include appropriate tables for:

- profiles
- workspaces
- workspace_members
- workspace_invitations
- projects
- tasks
- task_assignees
- subtasks
- task_comments
- task_attachments
- task_reminders
- notifications
- recurring_rules
- habits
- habit_logs
- focus_sessions
- notes
- activity_logs
- user_notification_preferences

Use UUID primary keys, foreign keys, timestamps, indexes, and appropriate constraints.

Make sure all workspace-related data has proper ownership and access control.

Provide SQL migrations and Supabase RLS policies.

## 16. Development Requirements

Do not build a static demo.

Every important UI element must work.

Implement:
- Real authentication.
- Real database CRUD.
- Proper workspace switching.
- Functional task management.
- Working reminders.
- Working calendar.
- Real analytics based on database records.
- Role-based access control.
- Responsive navigation.

Use reusable components and maintainable folder structures.

Avoid unnecessary abstractions and overengineering.

Do not use mock data as a substitute for real backend functionality.

If an external service requires API keys, create a proper environment variable configuration and document the setup.

## 17. Development Approach

Build the project incrementally.

Phase 1:
- Project setup.
- Authentication.
- Database schema.
- Personal workspace.
- Organization workspace.
- Main dashboard.

Phase 2:
- Task CRUD.
- Projects.
- Categories.
- Priorities.
- Subtasks.
- Kanban board.

Phase 3:
- Calendar.
- Recurring tasks.
- Reminder scheduler.
- Notifications.

Phase 4:
- Organization collaboration.
- Team assignments.
- Comments.
- Role-based permissions.

Phase 5:
- Focus mode.
- Habit tracker.
- Analytics.
- UI polish.
- Testing and security review.

Start by providing:
1. Complete system architecture.
2. Database schema and relationships.
3. Application folder structure.
4. Authentication and authorization strategy.
5. Implementation roadmap.

Then start implementing Phase 1.

Important: Build a genuinely usable product, not just a visually attractive dashboard. Prioritize data security, usability, and reliable reminders.