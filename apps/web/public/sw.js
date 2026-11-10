// LifeSync service worker: shows reminder notifications even when no tab is open, and lets people
// finish or snooze a task straight from the notification.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "LifeSync", body: event.data ? event.data.text() : "" };
  }
  const isTask = data.tag && data.tag.startsWith("task-");
  event.waitUntil(
    self.registration.showNotification(data.title || "LifeSync", {
      body: data.body || "",
      tag: data.tag || undefined,
      renotify: !!data.tag,
      icon: "/favicon.ico",
      data: { url: data.url || "/my-day", notificationId: data.notificationId },
      actions: isTask
        ? [
            { action: "complete", title: "Mark done" },
            { action: "snooze", title: "Snooze 10 min" },
          ]
        : [],
    }),
  );
});

async function act(path, body) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(String(res.status));
}

self.addEventListener("notificationclick", (event) => {
  const { url, notificationId } = event.notification.data || {};
  event.notification.close();

  event.waitUntil(
    (async () => {
      if (notificationId && (event.action === "complete" || event.action === "snooze")) {
        try {
          if (event.action === "complete") {
            await act(`/api/notifications/${notificationId}/complete`, {});
            await self.registration.showNotification("Done", { body: "Task marked as completed.", tag: "action-result", silent: true });
          } else {
            await act(`/api/notifications/${notificationId}/snooze`, { minutes: 10 });
            await self.registration.showNotification("Snoozed", { body: "We'll remind you again in 10 minutes.", tag: "action-result", silent: true });
          }
          return;
        } catch {
          // signed out or offline: fall through and open the app so the person can act there
        }
      }
      const target = new URL(url || "/my-day", self.location.origin).href;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          await w.focus();
          if ("navigate" in w) await w.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
