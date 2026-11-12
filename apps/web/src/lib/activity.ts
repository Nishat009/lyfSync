import { STATUS_LABELS, type ActivityEntry, type TaskStatus } from "@lifesync/shared";

const STATUS_VERB: Record<TaskStatus, string> = {
  todo: "moved it back to To do",
  in_progress: "started working on it",
  completed: "completed it",
  cancelled: "cancelled it",
};

/** One line of plain language for a timeline entry, without the actor's name or the task title. */
export function describeAction(e: ActivityEntry): string {
  const m = e.metadata as { fields?: string[]; status?: TaskStatus; name?: string; role?: string; title?: string };
  switch (e.action) {
    case "task.created":
      return "created the task";
    case "task.updated":
      return m.fields?.length ? `changed the ${m.fields.join(", ")}` : "edited the task";
    case "task.status_changed":
      return m.status ? STATUS_VERB[m.status] ?? `set the status to ${STATUS_LABELS[m.status]}` : "changed the status";
    case "task.assigned":
      return `assigned ${m.name ?? "someone"}`;
    case "task.unassigned":
      return `took ${m.name ?? "someone"} off the task`;
    case "task.commented":
      return "commented";
    case "task.archived":
      return "archived the task";
    case "task.unarchived":
      return "restored the task";
    case "task.deleted":
      return "deleted the task";
    case "member.joined":
      return "joined the workspace";
    default:
      return e.action.replace(/[._]/g, " ");
  }
}

/**
 * A feed line names the task, so the wording changes to fit around it:
 * "<actor> <lead> <task><tail>", e.g. "Maya assigned Nina to Launch plan" or "Omar commented on Launch plan".
 */
export function describeFeedLine(e: ActivityEntry): { lead: string; tail: string } {
  const m = e.metadata as { fields?: string[]; status?: TaskStatus; name?: string };
  switch (e.action) {
    case "task.created":
      return { lead: "created", tail: "" };
    case "task.updated":
      return { lead: "updated", tail: m.fields?.length ? ` (${m.fields.join(", ")})` : "" };
    case "task.status_changed": {
      const lead = { todo: "reopened", in_progress: "started", completed: "completed", cancelled: "cancelled" }[m.status ?? "todo"];
      return { lead: lead ?? "changed the status of", tail: "" };
    }
    case "task.assigned":
      return { lead: `assigned ${m.name ?? "someone"} to`, tail: "" };
    case "task.unassigned":
      return { lead: `took ${m.name ?? "someone"} off`, tail: "" };
    case "task.commented":
      return { lead: "commented on", tail: "" };
    case "task.archived":
      return { lead: "archived", tail: "" };
    case "task.unarchived":
      return { lead: "restored", tail: "" };
    case "task.deleted":
      return { lead: "deleted", tail: "" };
    default:
      return { lead: describeAction(e), tail: "" };
  }
}
