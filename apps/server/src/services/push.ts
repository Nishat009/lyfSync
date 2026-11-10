import webpush from "web-push";
import type { Config } from "../config";

export interface PushPayload {
  title: string;
  body: string;
  /** Where clicking the notification goes. */
  url: string;
  notificationId: string;
  /** Lets a newer notification replace an older one for the same task. */
  tag: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };

export interface PushSender {
  /** False when no VAPID keys are configured: pushes are skipped, never faked. */
  configured: boolean;
  publicKey: string | null;
  send(target: PushTarget, payload: PushPayload): Promise<PushResult>;
}

export function createPushSender(config: Config): PushSender {
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv } = config;
  if (!pub || !priv) {
    return { configured: false, publicKey: null, send: async () => ({ ok: false, gone: false, error: "push not configured" }) };
  }
  webpush.setVapidDetails(config.VAPID_SUBJECT, pub, priv);
  return {
    configured: true,
    publicKey: pub,
    async send(target, payload) {
      try {
        await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          JSON.stringify(payload),
          { TTL: 60 * 60, urgency: "high", topic: payload.tag.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, "") || undefined },
        );
        return { ok: true };
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        // 404/410: the browser removed the subscription for good.
        return { ok: false, gone: status === 404 || status === 410, error: `push failed${status ? ` (${status})` : ""}: ${(e as Error).message}`.slice(0, 300) };
      }
    },
  };
}
