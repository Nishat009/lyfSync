"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  REMINDER_OFFSETS,
  REMINDER_OFFSET_LABELS,
  changePasswordSchema,
  notificationPreferencesSchema,
  updateProfileSchema,
  type ChangePasswordInput,
  type NotificationPreferences,
  type PushStatus,
  type UpdateProfileInput,
} from "@lifesync/shared";
import { BellRing, Camera } from "lucide-react";
import { useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { useSession } from "@/components/app/session";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, ErrorState, Skeleton } from "@/components/ui/card";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { api, applyFormError } from "@/lib/api";
import { currentSubscription, disablePush, enablePush, pushSupport } from "@/lib/push";
import { invalidate, useQuery } from "@/lib/use-query";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function timezones(current: string): string[] {
  let list: string[] = [];
  try {
    list = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
  } catch {}
  return list.includes(current) ? list : [current, ...list];
}

function PushCard() {
  const status = useQuery<PushStatus>("/api/push/status");
  const device = useQuery<boolean>("local:push-subscription", () => currentSubscription().then(Boolean));
  const [busy, setBusy] = useState<string | null>(null);
  const supported = pushSupport() === "supported";
  const blocked = supported && typeof Notification !== "undefined" && Notification.permission === "denied";
  const on = device.data === true;

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
      invalidate("local:push");
      invalidate("/api/push");
    }
  };

  return (
    <Card>
      <CardHeader
        title="Notifications on this device"
        description="Get reminders as browser notifications, even when LifeSync is closed."
      />
      <div className="space-y-3 px-5 pb-5">
        {status.error ? (
          <ErrorState message={status.error.message} onRetry={status.reload} />
        ) : !status.data || device.loading ? (
          <Skeleton className="h-10" />
        ) : !supported ? (
          <p className="text-sm text-muted">This browser does not support push notifications.</p>
        ) : !status.data.configured ? (
          <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
            Push notifications are not set up on this server yet. An administrator needs to add VAPID keys (see the setup notes). In-app and email reminders still work.
          </p>
        ) : blocked ? (
          <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
            Notifications are blocked for this site. Allow them in your browser&apos;s site settings, then come back.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {on ? (
              <>
                <span className="flex items-center gap-1.5 text-sm text-personal">
                  <BellRing className="size-4" aria-hidden /> On for this device
                </span>
                <Button variant="outline" size="sm" loading={busy === "test"} onClick={() => run("test", async () => {
                  const r = await api<{ sent: number; failed: number }>("/api/push/test", { body: {} });
                  if (r.sent) toast.success("Test notification sent");
                  else toast.error("The test notification could not be delivered. Try turning notifications off and on again.");
                })}>
                  Send a test
                </Button>
                <Button variant="ghost" size="sm" loading={busy === "off"} onClick={() => run("off", async () => { await disablePush(); toast.success("Turned off for this device"); })}>
                  Turn off
                </Button>
              </>
            ) : (
              <Button loading={busy === "on"} onClick={() => run("on", async () => { await enablePush(status.data!.publicKey!); toast.success("Notifications are on for this device"); })}>
                <BellRing /> Turn on for this device
              </Button>
            )}
            <span className="text-xs text-muted">
              {status.data.subscriptions} {status.data.subscriptions === 1 ? "device" : "devices"} registered
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}

function ProfileCard() {
  const { profile } = useSession();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
    reset,
  } = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: { fullName: profile.fullName, timezone: profile.timezone, weekStartsOn: profile.weekStartsOn },
  });

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const body = new FormData();
      body.append("avatar", file);
      await api("/api/profile/avatar", { body });
      invalidate("/api/me");
      toast.success("Photo updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Card>
      <CardHeader title="Profile" description="Your name, photo and time zone. Reminders and “today” follow your time zone." />
      <div className="flex items-center gap-4 px-5 pb-4">
        <Avatar name={profile.fullName} src={profile.avatarUrl} className="size-16 text-base" />
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            aria-label="Profile photo"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          <Button variant="outline" size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>
            <Camera /> Upload photo
          </Button>
          {profile.avatarUrl && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await api("/api/profile/avatar", { method: "DELETE" });
                invalidate("/api/me");
              }}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      <form
        noValidate
        className="space-y-4 px-5 pb-5"
        onSubmit={handleSubmit(async (v) => {
          setFormError(null);
          try {
            await api("/api/profile", { method: "PATCH", body: v });
            invalidate("/api/me");
            invalidate("/api/dashboard");
            reset(v);
            toast.success("Profile saved");
          } catch (e) {
            setFormError(applyFormError(e, setError));
          }
        })}
      >
        <FormError message={formError} />
        <Field label="Full name" error={errors.fullName?.message}>
          {(p) => <Input {...p} {...register("fullName")} />}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Time zone" error={errors.timezone?.message}>
            {(p) => (
              <Select {...p} {...register("timezone")}>
                {timezones(profile.timezone).map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Week starts on">
            {(p) => (
              <Select {...p} {...register("weekStartsOn", { valueAsNumber: true })}>
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
          Save profile
        </Button>
      </form>
    </Card>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 size-4 accent-[var(--work)]" />
    </label>
  );
}

function NotificationsCard() {
  const { data, error, loading, reload } = useQuery<NotificationPreferences>("/api/notification-preferences");
  return (
    <Card>
      <CardHeader title="Notifications" description="Choose how reminders reach you." />
      {loading && !data ? (
        <Skeleton className="m-5 mt-0 h-40" />
      ) : error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : data ? (
        <NotificationsForm initial={data} />
      ) : null}
    </Card>
  );
}

function NotificationsForm({ initial }: { initial: NotificationPreferences }) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    control,
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<NotificationPreferences>({ resolver: zodResolver(notificationPreferencesSchema), defaultValues: initial });
  const quiet = useWatch({ control, name: "quietHoursEnabled" });

  return (
    <form
      noValidate
      className="space-y-4 px-5 pb-5"
      onSubmit={handleSubmit(async (v) => {
        setFormError(null);
        try {
          const saved = await api<NotificationPreferences>("/api/notification-preferences", { method: "PUT", body: v });
          reset(saved);
          toast.success("Preferences saved");
        } catch (e) {
          setFormError(applyFormError(e, setError));
        }
      })}
    >
      <FormError message={formError} />
      <div className="divide-y divide-border">
        <Controller control={control} name="inAppEnabled" render={({ field }) => <Toggle label="In-app notifications" checked={field.value} onChange={field.onChange} />} />
        <Controller
          control={control}
          name="pushEnabled"
          render={({ field }) => (
            <Toggle label="Browser push notifications" hint="Delivered even when LifeSync is closed, once your browser permits it." checked={field.value} onChange={field.onChange} />
          )}
        />
        <Controller control={control} name="emailEnabled" render={({ field }) => <Toggle label="Email notifications" checked={field.value} onChange={field.onChange} />} />
        <Controller
          control={control}
          name="missedReminderAlerts"
          render={({ field }) => <Toggle label="Missed reminder alerts" hint="Tell me about reminders I didn't see." checked={field.value} onChange={field.onChange} />}
        />
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">Default reminders for new tasks</legend>
        <Controller
          control={control}
          name="defaultReminderOffsets"
          render={({ field }) => (
            <div className="grid gap-2 sm:grid-cols-2">
              {REMINDER_OFFSETS.map((o) => (
                <label key={o} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--work)]"
                    checked={field.value.includes(o)}
                    onChange={(e) => field.onChange(e.target.checked ? [...field.value, o] : field.value.filter((x) => x !== o))}
                  />
                  {REMINDER_OFFSET_LABELS[o]}
                </label>
              ))}
            </div>
          )}
        />
      </fieldset>

      <div className="space-y-3">
        <Controller control={control} name="quietHoursEnabled" render={({ field }) => <Toggle label="Quiet hours" hint="Hold non-urgent notifications during these hours." checked={field.value} onChange={field.onChange} />} />
        {quiet && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="From" error={errors.quietHoursStart?.message}>
              {(p) => <Input type="time" {...p} {...register("quietHoursStart", { setValueAs: (v) => v || null })} />}
            </Field>
            <Field label="Until" error={errors.quietHoursEnd?.message}>
              {(p) => <Input type="time" {...p} {...register("quietHoursEnd", { setValueAs: (v) => v || null })} />}
            </Field>
          </div>
        )}
      </div>
      <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
        Save preferences
      </Button>
    </form>
  );
}

function PasswordCard() {
  const { user } = useSession();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema) });

  return (
    <Card>
      <CardHeader
        title={user.hasPassword ? "Change password" : "Set a password"}
        description={user.hasPassword ? "Other devices will be signed out." : "You signed up with Google. Add a password to also sign in with email."}
      />
      <form
        noValidate
        className="space-y-4 px-5 pb-5"
        onSubmit={handleSubmit(async (v) => {
          setFormError(null);
          try {
            await api("/api/auth/change-password", { body: v });
            invalidate("/api/me");
            reset({ currentPassword: "", newPassword: "" });
            toast.success("Password updated");
          } catch (e) {
            setFormError(applyFormError(e, setError));
          }
        })}
      >
        <FormError message={formError} />
        {user.hasPassword && (
          <Field label="Current password" error={errors.currentPassword?.message}>
            {(p) => <Input type="password" autoComplete="current-password" {...p} {...register("currentPassword")} />}
          </Field>
        )}
        <Field label="New password" error={errors.newPassword?.message} hint="At least 8 characters.">
          {(p) => <Input type="password" autoComplete="new-password" {...p} {...register("newPassword")} />}
        </Field>
        <Button type="submit" loading={isSubmitting}>
          Update password
        </Button>
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">Manage your profile, notifications and security.</p>
      </div>
      <ProfileCard />
      <PushCard />
      <NotificationsCard />
      <PasswordCard />
    </div>
  );
}
